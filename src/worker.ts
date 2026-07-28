import { loadAgents } from './agents.ts'
import { boardNs, connect, KEYS, type AgentRequest, type AgentResponse } from './bus.ts'
import { invoke, type Role } from './claude.ts'

/**
 * 常駐的 agent 行程。
 *
 * 一個角色一個行程：訂閱自己的派工佇列，接到就工作，把結果發回。
 * 這是「agent 是實體」與「agent 是被呼叫的函式」的差別 ——
 * 它有自己的生命週期，coordinator 不知道它什麼時候起來、什麼時候重啟。
 *
 * 自己載入自己的定義檔（model / effort / 系統提示），所以 coordinator
 * 只需要送「要做什麼、在哪做」。改了定義檔就重啟這個行程，不用動別的東西。
 */

export interface WorkerOptions {
  role: Role
  /** 從哪裡讀 agent 定義（board repo） */
  boardDir: string
  log?: (line: string) => void
  /** 收工訊號。測試用；正式跑是收 SIGINT/SIGTERM */
  signal?: AbortSignal
}

export async function runWorker(opts: WorkerOptions): Promise<void> {
  const log = opts.log ?? ((l: string) => console.log(l))
  const agents = await loadAgents(opts.boardDir)
  const spec = agents[opts.role]
  const client = await connect()
  const ns = boardNs(opts.boardDir)
  const queue = KEYS.request(ns, opts.role)

  /**
   * 每個 repo 的 session。這是常駐真正的價值 ——
   * 第二次被叫到同一個 repo 時，它已經認識那份 codebase 了。
   */
  const sessions = new Map<string, string>()

  log(`${opts.role} agent 待命中（${spec.model} / ${spec.effort}）· board ${ns}`)

  try {
    while (!opts.signal?.aborted) {
      // 阻塞式等待，一秒逾時一次 —— 讓收工訊號有機會被看到。
      // 逾時不代表出事，只是「這一秒沒有派工」。
      const item = await client.blPop(queue, 1)
      if (!item) continue

      let req: AgentRequest
      try {
        req = JSON.parse(item.element) as AgentRequest
      } catch {
        log(`  收到無法解析的派工，略過`)
        continue
      }

      // coordinator 早就放棄的派工不該執行 —— 做了也沒人收，純粹是燒錢
      if (typeof req.deadline === 'number' && Date.now() > req.deadline) {
        log(`  略過過期的派工 ${req.id.slice(0, 8)}（coordinator 已放棄）`)
        continue
      }

      if (req.fresh) sessions.delete(req.cwd)
      const resume = sessions.get(req.cwd)
      log(`  接到派工 ${req.id.slice(0, 8)}${resume ? '（續接既有 session）' : '（新 session）'}`)

      const result = await invoke(spec, req.prompt, { cwd: req.cwd, resume })
      if (result.sessionId) sessions.set(req.cwd, result.sessionId)
      const res: AgentResponse = { id: req.id, ...result }

      // 回覆佇列設短 TTL —— coordinator 早就逾時放棄的回覆不該永遠留著
      await client.rPush(KEYS.response(ns, req.id), JSON.stringify(res))
      await client.expire(KEYS.response(ns, req.id), 3600)

      log(`  完成 ${req.id.slice(0, 8)}${result.costUsd ? `（$${result.costUsd.toFixed(2)}）` : ''}`)
    }
  } finally {
    await client.quit()
    log(`${opts.role} agent 收工`)
  }
}
