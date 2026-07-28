import { loadAgents } from './agents.ts'
import { boardNs, connect, KEYS, type Command } from './bus.ts'
import { BusDispatcher } from './bus.ts'
import { planAll } from './plan.ts'
import { drain } from './runner.ts'

/**
 * 常駐服務：等入口層下指令，然後排空或規劃。
 *
 * 這是「你在手機上講一句就開跑」的接收端 —— 入口層（Discord bot / TG / 你自己
 * 寫的腳本）把指令發到匯流排，這裡撿起來執行，過程中的事件再發回匯流排讓
 * 入口層即時顯示。
 *
 * 指令用 LIST 而非 pub/sub：服務重啟時發出的指令不該消失。
 * 排程也是同一個機制 —— 指令帶 `at` 就是「幾點跑」，服務會等到那個時間。
 */

export interface ServeOptions {
  boardDir: string
  log?: (line: string) => void
  signal?: AbortSignal
}

export async function serve(opts: ServeOptions): Promise<void> {
  const log = opts.log ?? ((l: string) => console.log(l))
  const boardDir = opts.boardDir
  const ns = boardNs(boardDir)
  const client = await connect()
  const queue = KEYS.commands(ns)

  log(`taskcrew 服務待命中 · board ${ns}`)
  log('等指令中。入口層可以發 run 或 plan 到匯流排。')

  try {
    while (!opts.signal?.aborted) {
      const item = await client.blPop(queue, 1)
      if (!item) continue

      let cmd: Command
      try {
        cmd = JSON.parse(item.element) as Command
      } catch {
        log('收到無法解析的指令，略過')
        continue
      }

      // 指定時間的指令：等到那個時候。中途收到收工訊號就把它放回去 ——
      // 排程好的工作不該因為服務重啟而消失。
      if (cmd.at && cmd.at > Date.now()) {
        const wait = cmd.at - Date.now()
        log(`收到排程指令 ${cmd.type}，${Math.round(wait / 1000)} 秒後執行`)
        const fired = await sleepUnlessAborted(wait, opts.signal)
        if (!fired) {
          await client.rPush(queue, JSON.stringify(cmd))
          break
        }
      }

      log(`執行 ${cmd.type}`)
      const agents = await loadAgents(boardDir)
      const dispatch = await BusDispatcher.create(boardDir, agents, log)
      try {
        if (cmd.type === 'plan') {
          const s = await planAll({ boardDir, dispatch, log })
          log(`規劃完成：${s.planned} 張、等上游 ${s.waiting} 張，花費 $${s.costUsd.toFixed(2)}`)
        } else {
          const s = await drain({ boardDir, dispatch, log })
          log(`排空完成：完成 ${s.done}、未通過 ${s.failed}，花費 $${s.costUsd.toFixed(2)}`)
        }
      } finally {
        await dispatch.close()
      }
    }
  } finally {
    await client.quit()
    log('taskcrew 服務收工')
  }
}

/** 回傳 true 表示睡飽了，false 表示被收工訊號打斷 */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false)
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
