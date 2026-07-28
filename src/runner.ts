import { listCards, setStatus } from './board.ts'
import type { Dispatcher } from './dispatch.ts'
import { acceptedBranch } from './pipeline.ts'
import { expandHome } from './gate.ts'
import { git } from './shell.ts'
import { checkGate, children } from './gate.ts'
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

    const repo = expandHome(card.runner!.project)
    const r = await runPipeline(card, {
      dispatch: d,
      baseRef: await baseRefFor(card, all, repo, d),
      mergeRefs: await existingRefs(
        children(card, all).map((c) => acceptedBranch(c.id)),
        repo,
      ),
    })
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

/**
 * 這張卡的分支該從哪裡長出來。
 *
 * 有依賴就從**最後一個依賴的成果**長出來 —— 依賴的意思就是「我需要它做完的東西」，
 * 從 base_branch 長出來的話那些東西根本不存在，plan 裡寫的「呼叫 A 新加的函式」
 * 會直接找不到。多個依賴時取最後一個：它們是鏈狀的（A→B→C），
 * 最後一個已經含有前面所有人的成果。
 *
 * 沒有依賴（含所有父卡）就用卡上寫的 base_branch。
 */
async function baseRefFor(
  card: Card,
  all: readonly Card[],
  repo: string,
  d: Dispatcher,
): Promise<string> {
  const fallback = card.runner!.base_branch
  const done = card.dependencies.filter((id) => all.find((c) => c.id === id)?.status === '完成')
  const last = done[done.length - 1]
  if (!last) return fallback

  // 「完成」不保證有成果分支 —— 看板是人可以編輯的，你隨時可能手動把一張卡
  // 拖到完成而它從沒真的跑過。那時候從 base_branch 長出來是唯一合理的選擇，
  // 但要說出來：卡片的 plan 可能假設了不存在的東西。
  const ref = acceptedBranch(last)
  if (await refExists(ref, repo)) return ref
  d.emit({ type: 'missing-ref', card: card.id, ref, fallback })
  return fallback
}

/** 過濾掉不存在的分支。手動標記完成的子卡沒有成果可合。 */
async function existingRefs(refs: string[], repo: string): Promise<string[]> {
  const out: string[] = []
  for (const r of refs) if (await refExists(r, repo)) out.push(r)
  return out
}

async function refExists(ref: string, repo: string): Promise<boolean> {
  return (await git(repo, ['rev-parse', '--verify', '--quiet', ref])).code === 0
}

/** 給 CLI 用的：卡在「規劃中」的張數，提醒使用者還有 PM 的工作沒跑。 */
export async function countPlanning(boardDir: string): Promise<number> {
  const all = await listCards(boardDir)
  return all.filter((c: Card) => c.status === STATUS.規劃中).length
}
