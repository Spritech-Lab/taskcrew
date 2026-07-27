import { listCards, setStatus } from './board.ts'
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
  /** 只列出會做什麼，不呼叫 agent、不改任何檔案 */
  dryRun?: boolean
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
    log('「待執行」沒有卡，收工。')
    return s
  }
  log(`「待執行」有 ${queue.length} 張卡。`)

  for (const card of queue) {
    const verdict = await checkGate(card, all)

    if (verdict.kind === 'blocked') {
      log(`⏸  ${card.id} ${card.title} —— 等 ${verdict.waitingOn.join('、')}`)
      s.blocked++
      if (!opts.dryRun) await setStatus(card, STATUS.阻塞)
      continue
    }

    if (verdict.kind === 'fail') {
      log(`✗  ${card.id} ${card.title} —— 沒過閘門：`)
      for (const p of verdict.problems) log(`     · ${p}`)
      s.rejected++
      continue
    }

    if (opts.dryRun) {
      log(`▸  ${card.id} ${card.title} —— 會執行（dry-run）`)
      continue
    }

    log(`▸  ${card.id} ${card.title}`)
    await setStatus(card, STATUS.執行中)

    const r = await runPipeline(card, { log })
    s.costUsd += r.costUsd

    switch (r.kind) {
      case 'done':
        log(`   ✓ 通過（${r.attempts.length} 個方案，$${r.costUsd.toFixed(2)}）`)
        await setStatus(card, STATUS.執行完成回報)
        s.done++
        break

      case 'proposed':
        // autonomy: propose —— PM 想出新方案但不准自己執行。球回到你手上。
        log(`   ↩ PM 提出新方案，退回「設計待批准」等你批准`)
        await setStatus(card, STATUS.設計待批准)
        s.proposed++
        break

      case 'rate-limited':
        // 唯一的正常煞車。卡乾淨退回，分支留著，下次接得回去。
        await setStatus(card, STATUS.待執行)
        log('⏹  撞到訂閱額度上限，停止排空。卡已退回「待執行」，分支留著。')
        s.stoppedByLimit = true
        return s

      case 'failed':
        log(`   ✗ ${r.reason}`)
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
