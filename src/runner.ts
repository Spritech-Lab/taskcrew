import { listCards, setStatus } from './board.ts'
import type { Dispatcher } from './dispatch.ts'
import { checkGate } from './gate.ts'
import { runPipeline } from './pipeline.ts'
import { STATUS, type Card } from './types.ts'

/**
 * 排空「待執行」欄。
 *
 * 逐筆序列執行 —— 一次只有一張卡在動，所以不需要鎖，也不會有一致性問題。
 * 結束條件只有兩個：queue 空了，或撞到訂閱額度（設計文件 §7.3、§7.4）。
 */

export interface DrainOptions {
  boardDir: string
  /** agent 怎麼被叫起來，以及事件往哪送 */
  dispatch: Dispatcher
  /** 只列出會做什麼，不呼叫 agent、不改任何檔案 */
  dryRun?: boolean
  /** dry-run 的說明文字。正式執行時所有輸出都走 dispatch.emit */
  log?: (line: string) => void
}

export interface DrainSummary {
  done: number
  failed: number
  proposed: number
  blocked: number
  rejected: number
  stoppedByLimit: boolean
  costUsd: number
}

export async function drain(opts: DrainOptions): Promise<DrainSummary> {
  const d = opts.dispatch
  const log = opts.log ?? ((l: string) => console.log(l))
  const s: DrainSummary = {
    done: 0,
    failed: 0,
    proposed: 0,
    blocked: 0,
    rejected: 0,
    stoppedByLimit: false,
    costUsd: 0,
  }

  const all = await listCards(opts.boardDir)
  const queue = all
    .filter((c) => c.status === STATUS.待執行)
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))

  if (queue.length === 0) {
    d.emit({ type: 'queue-empty' })
    return s
  }
  d.emit({ type: 'queue-start', count: queue.length })

  for (const card of queue) {
    const verdict = await checkGate(card, all)

    if (verdict.kind === 'blocked') {
      d.emit({ type: 'card-blocked', card: card.id, waitingOn: verdict.waitingOn })
      s.blocked++
      if (!opts.dryRun) await setStatus(card, STATUS.阻塞)
      continue
    }

    if (verdict.kind === 'fail') {
      d.emit({ type: 'card-rejected', card: card.id, problems: verdict.problems })
      s.rejected++
      continue
    }

    if (opts.dryRun) {
      log(`▸  ${card.id} ${card.title} —— 會執行（dry-run）`)
      continue
    }

    d.emit({ type: 'card-start', card: card.id, title: card.title })
    await setStatus(card, STATUS.執行中)

    const r = await runPipeline(card, { dispatch: d })
    s.costUsd += r.costUsd

    switch (r.kind) {
      case 'done':
        d.emit({ type: 'card-done', card: card.id, attempts: r.attempts.length, costUsd: r.costUsd })
        await setStatus(card, STATUS.執行完成回報)
        s.done++
        break

      case 'proposed':
        // autonomy: propose —— PM 想出新方案但不准自己執行。球回到你手上。
        d.emit({ type: 'card-proposed', card: card.id })
        await setStatus(card, STATUS.設計待批准)
        s.proposed++
        break

      case 'rate-limited':
        // 唯一的正常煞車。卡乾淨退回，分支留著，下次接得回去。
        await setStatus(card, STATUS.待執行)
        d.emit({ type: 'rate-limited', card: card.id })
        s.stoppedByLimit = true
        return s

      case 'failed':
        d.emit({ type: 'card-failed', card: card.id, reason: r.reason })
        await setStatus(card, STATUS.執行完成回報)
        s.failed++
        break
    }
  }

  return s
}

/** 給 CLI 用的：卡在「規劃中」的張數，提醒使用者還有 PM 的工作沒跑。 */
export async function countPlanning(boardDir: string): Promise<number> {
  const all = await listCards(boardDir)
  return all.filter((c: Card) => c.status === STATUS.規劃中).length
}
