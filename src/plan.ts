import { listCards, setStatus, stripLeadingHeading, upsertSection } from './board.ts'
import { isRateLimited } from './claude.ts'
import { children, expandHome, satisfiesDownstream } from './gate.ts'
import type { Dispatcher } from './dispatch.ts'
import { STATUS, type Card } from './types.ts'
import { baseRefFor, mergeRefsFor, withWorktree } from './workspace.ts'

/**
 * PM 的規劃階段：把「規劃中」的卡變成「設計待批准」。
 *
 * 這是刻意獨立於排空迴圈的一個指令。理由是它跨越的是**審查點 1 到審查點 2**
 * 之間那一段 —— 你確認了拆解（把卡拖進「規劃中」），PM 研究 codebase 產出做法，
 * 然後球回到你手上等你審做法。
 *
 * PM 不寫實作。它產出的 Implementation Plan 是你在「設計待批准」那一欄
 * 唯一會看的東西，通過後才交給 RD。
 */

export interface PlanOptions {
  boardDir: string
  dispatch: Dispatcher
  dryRun?: boolean
  log?: (line: string) => void
}

export interface PlanSummary {
  planned: number
  failed: number
  /** 父卡因為子卡還沒產出成果而還沒輪到規劃 */
  waiting: number
  stoppedByLimit: boolean
  costUsd: number
}

export async function planAll(opts: PlanOptions): Promise<PlanSummary> {
  const log = opts.log ?? ((l: string) => console.log(l))
  const s: PlanSummary = { planned: 0, failed: 0, waiting: 0, stoppedByLimit: false, costUsd: 0 }

  const all = await listCards(opts.boardDir)
  const pending = all
    .filter((c) => c.status === STATUS.規劃中)
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))

  if (pending.length === 0) {
    log('「規劃中」沒有卡。')
    return s
  }
  log(`「規劃中」有 ${pending.length} 張卡。`)

  for (const card of pending) {
    // 父卡的工作是整合子卡的**實際產出**，所以在子卡跑完之前根本規劃不了 ——
    // 那時要串接的介面還不存在，PM 只能瞎猜。跟閘門用同一條規則
    // （satisfiesDownstream），只是提早到規劃階段。
    //
    // 實跑驗證過：不擋的話 PM 自己會停手回報「三個子模組完全不存在」。
    // 它的判斷是對的，但那要花一次 Opus 呼叫才換到一句我們早就知道的話。
    const waitingOn: Card[] = []
    for (const child of children(card, all)) {
      if (!(await satisfiesDownstream(child))) waitingOn.push(child)
    }
    if (waitingOn.length > 0) {
      log(`⏸  ${card.id} ${card.title} —— 等子卡完成：${waitingOn.map((c) => c.id).join('、')}`)
      s.waiting++
      continue
    }

    // 規劃階段唯一必要的前提是知道要在哪個 repo 研究。
    // 其餘欄位由閘門在進「待執行」時把關，這裡不重複檢查。
    if (!card.runner) {
      log(`✗  ${card.id} ${card.title} —— 缺少可解析的 \`## Runner Config\`，PM 不知道要研究哪個 repo`)
      s.failed++
      continue
    }

    if (opts.dryRun) {
      log(`▸  ${card.id} ${card.title} —— 會規劃（dry-run）`)
      continue
    }

    log(`▸  ${card.id} ${card.title}`)
    const repo = expandHome(card.runner.project)

    // PM 要看的是 **RD 將會站的地方**，不是 repo 當下剛好停在哪。
    // 用暫時的 worktree 而不是 checkout：規劃是唯讀的工作，不該改動 repo 狀態。
    const base = await baseRefFor(card, all, repo, (ref, fallback) =>
      log(`   ⚠ 依賴的成果分支 ${ref} 不存在，改用 ${fallback}`),
    )
    const merges = await mergeRefsFor(card, all, repo)
    if (merges.length > 0) log(`   合入子卡成果：${merges.join('、')}`)

    const r = await withWorktree(repo, base, merges, (dir) =>
      opts.dispatch.invoke('pm', planPrompt(card), dir),
    )
    s.costUsd += r.costUsd ?? 0

    if (isRateLimited(r)) {
      log('⏹  撞到訂閱額度上限，停止規劃。')
      s.stoppedByLimit = true
      return s
    }
    if (!r.ok || !r.text.trim()) {
      log(`   ✗ PM 沒有產出 plan（exit ${r.exitCode}）`)
      s.failed++
      continue
    }

    // PM 也可以喊停 —— 需求不清楚時硬產一份 plan 只會把問題往下游推。
    const blocked = /^\s*BLOCKED:\s*(.+)$/m.exec(r.text)
    if (blocked) {
      log(`   ↩ PM 停手：${blocked[1].trim()}`)
      await upsertSection(card, 'Implementation Plan', `**PM 無法規劃**\n\n${r.text.trim()}`)
      await setStatus(card, STATUS.需求討論)
      s.failed++
      continue
    }

    await upsertSection(card, 'Implementation Plan', stripLeadingHeading(r.text, 'Implementation Plan'))
    await setStatus(card, STATUS.設計待批准)
    log(`   ✓ 已產出做法，等你批准（$${(r.costUsd ?? 0).toFixed(2)}）`)
    s.planned++
  }

  return s
}

function planPrompt(card: Card): string {
  return [
    `## 規劃：${card.title}`,
    '',
    '### 需求',
    section(card, 'Description'),
    '',
    '### 驗收條件',
    section(card, 'Acceptance Criteria'),
    '',
    '請研究這個 repo 的實際結構，產出一份 Implementation Plan：',
    '要動哪些檔、用什麼做法、有什麼風險。',
    '',
    '要具體到 RD 拿了就能動手，但**不要幫他把 code 寫出來** —— 你產出的是做法，不是實作。',
    '需求不清楚、或需要替使用者做設計抉擇時，第一行寫 `BLOCKED: <你需要什麼決定>`。',
    '',
    '請直接輸出 plan 本身（markdown），不要加前言或說明。',
  ].join('\n')
}

function section(card: Card, name: string): string {
  return (card.sections[name] ?? '').replace(/<!--[\s\S]*?-->/g, '').trim() || '（無）'
}
