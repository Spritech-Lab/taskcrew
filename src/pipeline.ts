import { stripLeadingHeading, upsertSection } from './board.ts'
import { invoke, isRateLimited } from './claude.ts'
import { expandHome } from './gate.ts'
import { JUNIOR_RD, PM, QA, SENIOR_RD } from './roles.ts'
import { describeVerdict, parseVerdict, type QaVerdict } from './qa.ts'
import { analyze, describe, shouldEscalate } from './shape.ts'
import { git } from './shell.ts'
import type { Autonomy, Card, TestResult } from './types.ts'
import { passed, summarize, verify } from './verify.ts'

/**
 * 一張卡的完整產線。三層循環：
 *
 *   內層 —— 實作沒寫對：junior 開發 → 測試 → senior 減法 → 測試 → QA
 *            沒過就由 senior 接手開發（保留 junior 的 code，路是對的）
 *   中層 —— 做法本身不對：PM 在乾淨 context 重新規劃，換一個方案
 *            新方案 = 新分支，從 base_branch 乾淨開始（路走錯了，code 一起丟）
 *   外層 —— 需求或方向不對：停下來，把球交回給人
 *
 * 三層的成本與能力同時遞增，而且每次升級都**真的換了東西**，
 * 不是同一個東西再試一次。對應設計文件 §8.3。
 */

/** 內層輪次上限。超過就代表這不是機器自己能解決的，該升級。 */
const MAX_ROUNDS = 2

interface RoundRecord {
  no: number
  role: 'junior' | 'senior'
  results: TestResult[] | null
  verifySummary: string
  qa: QaVerdict | null
  cost: number
}

interface AttemptRecord {
  no: number
  branch: string
  plan: string
  rounds: RoundRecord[]
  ended:
    | 'passed'
    | 'infeasible'
    | 'plan-inadequate'
    | 'shape'
    | 'rounds-exhausted'
    | 'blocked'
    | 'error'
  reason: string
  cost: number
}

export type PipelineResult =
  | { kind: 'done'; attempts: AttemptRecord[]; costUsd: number }
  | { kind: 'failed'; attempts: AttemptRecord[]; costUsd: number; reason: string }
  /** autonomy: propose —— PM 想出了新方案但不執行，卡退回「設計待批准」 */
  | { kind: 'proposed'; attempts: AttemptRecord[]; costUsd: number; newPlan: string }
  | { kind: 'rate-limited'; attempts: AttemptRecord[]; costUsd: number }

export interface PipelineOptions {
  log: (line: string) => void
}

export async function runPipeline(
  card: Card,
  opts: PipelineOptions,
): Promise<PipelineResult> {
  const cfg = card.runner!
  const repo = expandHome(cfg.project)
  const log = opts.log

  const attempts: AttemptRecord[] = []
  const excluded: string[] = []
  let plan = section(card, 'Implementation Plan')
  let cost = 0

  const maxAttempts = attemptBudget(cfg.autonomy)

  for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
    const branch = `task/${card.id.toLowerCase()}-attempt-${attemptNo}`

    // 換方案 = 從 base_branch 乾淨長出來。上一個方案的 code 不繼承 ——
    // 路走錯了，在爛攤子上改只會讓新方案變成舊方案的變體。
    const co = await git(repo, ['checkout', '-B', branch, cfg.base_branch])
    if (co.code !== 0) {
      return {
        kind: 'failed',
        attempts,
        costUsd: cost,
        reason: `無法建立分支 ${branch}：${co.stderr.trim()}`,
      }
    }
    log(`   [方案 ${attemptNo}] 分支 ${branch}`)

    const attempt = await runAttempt(card, repo, branch, plan, attemptNo, log)
    attempts.push(attempt)
    cost += attempt.cost

    if (attempt.ended === 'passed') {
      await commit(repo, card)
      await writeNotes(card, attempts)
      return { kind: 'done', attempts, costUsd: cost }
    }

    if (attempt.ended === 'blocked' || attempt.ended === 'error') {
      await writeNotes(card, attempts)
      return { kind: 'failed', attempts, costUsd: cost, reason: attempt.reason }
    }

    // 走到這裡代表要換方案。先看 autonomy 允不允許。
    excluded.push(formatExcluded(attempt))
    await appendExcluded(card, excluded)

    if (attemptNo >= maxAttempts) break

    log(`   [方案 ${attemptNo}] ${attempt.reason} → 交回 PM 重新規劃`)
    const replan = await invoke(PM, replanPrompt(card, attempt, excluded), { cwd: repo })
    cost += replan.costUsd ?? 0
    if (isRateLimited(replan)) return { kind: 'rate-limited', attempts, costUsd: cost }
    if (!replan.ok || !replan.text.trim()) {
      await writeNotes(card, attempts)
      return { kind: 'failed', attempts, costUsd: cost, reason: 'PM 無法產出新方案' }
    }

    plan = stripLeadingHeading(replan.text, 'Implementation Plan')

    // autonomy: propose —— 想得出新方案，但不准自己執行。
    // 這是預設值：就算不放行，早上你也會看到它想出的方案，那本身就是磨合的素材。
    if (cfg.autonomy.kind === 'propose') {
      await upsertSection(card, 'Implementation Plan', plan)
      await writeNotes(card, attempts)
      return { kind: 'proposed', attempts, costUsd: cost, newPlan: plan }
    }
  }

  await writeNotes(card, attempts)
  const last = attempts[attempts.length - 1]
  return {
    kind: 'failed',
    attempts,
    costUsd: cost,
    reason: last ? last.reason : '沒有任何嘗試被執行',
  }
}

/** 一個方案的內層循環：最多 MAX_ROUNDS 輪。 */
async function runAttempt(
  card: Card,
  repo: string,
  branch: string,
  plan: string,
  attemptNo: number,
  log: (l: string) => void,
): Promise<AttemptRecord> {
  const cfg = card.runner!
  const rec: AttemptRecord = {
    no: attemptNo,
    branch,
    plan,
    rounds: [],
    ended: 'rounds-exhausted',
    reason: '',
    cost: 0,
  }

  for (let roundNo = 1; roundNo <= MAX_ROUNDS; roundNo++) {
    const isFirst = roundNo === 1
    const dev = isFirst ? JUNIOR_RD : SENIOR_RD
    const round: RoundRecord = {
      no: roundNo,
      role: isFirst ? 'junior' : 'senior',
      results: null,
      verifySummary: '',
      qa: null,
      cost: 0,
    }
    rec.rounds.push(round)

    log(`   [方案 ${attemptNo}·輪 ${roundNo}] ${dev.role} 開發（${dev.model} / ${dev.effort}）`)
    const devResult = await invoke(
      dev,
      isFirst ? devPrompt(card, plan) : takeoverPrompt(card, plan, rec),
      { cwd: repo },
    )
    round.cost += devResult.costUsd ?? 0
    rec.cost += devResult.costUsd ?? 0

    if (isRateLimited(devResult)) {
      rec.ended = 'error'
      rec.reason = 'rate-limited'
      return rec
    }
    if (!devResult.ok) {
      rec.ended = 'error'
      rec.reason = `agent 執行失敗（exit ${devResult.exitCode}）`
      return rec
    }

    // RD 主動宣告方案不可行 —— 最快、最有價值的升級訊號。
    // 不用等輪次跑完，也不用等測試。
    const infeasible = firstLine(devResult.text, 'PLAN_INFEASIBLE')
    if (infeasible) {
      rec.ended = 'infeasible'
      rec.reason = `RD 回報方案不可行：${infeasible}`
      return rec
    }
    const blocked = firstLine(devResult.text, 'BLOCKED')
    if (blocked) {
      rec.ended = 'blocked'
      rec.reason = `RD 停手等決定：${blocked}`
      return rec
    }

    // 先確認它能動
    let v = await verify(cfg.verify, repo)
    round.results = v.results
    round.verifySummary = summarize(v)
    log(`   [方案 ${attemptNo}·輪 ${roundNo}] 驗收 ${round.verifySummary}`)

    // 減法只在第一輪做 —— 第二輪的開發者就是 senior，他寫的時候已經在減了。
    if (isFirst && passed(v)) {
      log(`   [方案 ${attemptNo}·輪 ${roundNo}] senior 減法 review`)
      const reduce = await invoke(SENIOR_RD, reducePrompt(card, plan), { cwd: repo })
      round.cost += reduce.costUsd ?? 0
      rec.cost += reduce.costUsd ?? 0
      if (isRateLimited(reduce)) {
        rec.ended = 'error'
        rec.reason = 'rate-limited'
        return rec
      }
      // 減法是修改，修改就要驗證。這是防止減過頭的唯一保險。
      v = await verify(cfg.verify, repo)
      round.results = v.results
      round.verifySummary = summarize(v)
      log(`   [方案 ${attemptNo}·輪 ${roundNo}] 減法後驗收 ${round.verifySummary}`)
    }

    const shape = analyze(rec.rounds.map((r) => r.results))

    if (passed(v)) {
      // 測試過了才問 QA。QA 回答的是測試回答不了的那個問題：符不符合要求。
      log(`   [方案 ${attemptNo}·輪 ${roundNo}] QA 判定`)
      const qaResult = await invoke(QA, qaPrompt(card, plan, v.results), { cwd: repo })
      round.cost += qaResult.costUsd ?? 0
      rec.cost += qaResult.costUsd ?? 0
      if (isRateLimited(qaResult)) {
        rec.ended = 'error'
        rec.reason = 'rate-limited'
        return rec
      }
      const verdict = parseVerdict(qaResult.text)
      round.qa = verdict

      if (verdict.kind === 'pass') {
        rec.ended = 'passed'
        rec.reason = '驗收與 QA 都通過'
        return rec
      }
      if (verdict.kind === 'plan-inadequate') {
        rec.ended = 'plan-inadequate'
        rec.reason = `QA 判定方案不足：${verdict.detail}`
        return rec
      }
      log(`   [方案 ${attemptNo}·輪 ${roundNo}] QA 退回：${describeVerdict(verdict)}`)
      continue
    }

    // 測試沒過。形狀說了算 —— 該留內層修，還是這個方案根本碰不到那些條件。
    if (shouldEscalate(shape)) {
      rec.ended = 'shape'
      rec.reason = describe(shape)
      return rec
    }
    log(`   [方案 ${attemptNo}·輪 ${roundNo}] ${describe(shape)} → 留內層`)
  }

  rec.ended = 'rounds-exhausted'
  rec.reason = `內層 ${MAX_ROUNDS} 輪用盡仍未通過`
  return rec
}

// ── autonomy ────────────────────────────────────────────────────────────

function attemptBudget(a: Autonomy): number {
  switch (a.kind) {
    case 'none':
      return 1
    case 'propose':
      // 跑一個方案；失敗後 PM 產新方案但不執行，卡退回等你批准
      return 2
    case 'replan':
      return a.max + 1
    case 'free':
      // 沒有次數上限，實際的煞車是訂閱額度
      return Number.MAX_SAFE_INTEGER
  }
}

// ── prompts ─────────────────────────────────────────────────────────────

function devPrompt(card: Card, plan: string): string {
  return [
    `## 本次任務：${card.title}`,
    '',
    '### 需求',
    section(card, 'Description'),
    '',
    '### 驗收條件',
    section(card, 'Acceptance Criteria'),
    '',
    '### 已批准的做法',
    plan,
    '',
    '照上面的做法實作。改動留在工作區即可 —— 不要 commit、不要 push。',
  ].join('\n')
}

function takeoverPrompt(card: Card, plan: string, rec: AttemptRecord): string {
  const prev = rec.rounds[rec.rounds.length - 2]
  const failing = prev?.results?.filter((r) => !r.passed).map((r) => `- ${r.name}`) ?? []
  return [
    `## 接手任務：${card.title}`,
    '',
    'junior 已經照計畫做過一輪但沒通過。**工作區裡是他的成果，路是對的，實作沒做好。**',
    '在他的基礎上修，不要打掉重寫 —— 他多半只是卡在某個具體的點。',
    '',
    '### 上一輪沒過的測試',
    failing.length ? failing.join('\n') : `（驗收結果：${prev?.verifySummary ?? '未知'}）`,
    ...(prev?.qa ? ['', '### QA 的意見', describeVerdict(prev.qa)] : []),
    '',
    '### 驗收條件',
    section(card, 'Acceptance Criteria'),
    '',
    '### 已批准的做法',
    plan,
    '',
    '改動留在工作區即可 —— 不要 commit、不要 push。',
  ].join('\n')
}

function reducePrompt(card: Card, plan: string): string {
  return [
    `## 減法 review：${card.title}`,
    '',
    '測試已經全過了。你的工作是**把多餘的東西拿掉**，不是加東西、也不是重寫。',
    '',
    '看工作區裡未 commit 的改動，刪掉：',
    '- 沒被要求的功能與抽象',
    '- 對不可能發生的情況的防禦',
    '- 說明下一行在做什麼的註解',
    '- 為假想的未來需求做的設計',
    '',
    '但**不要為了讓結構好看而硬拆高耦合的東西**。有些耦合就是該這麼高。',
    '',
    '### 本次任務的範圍（超出這個範圍的東西一律不該存在）',
    section(card, 'Description'),
    '',
    '### 已批准的做法',
    plan,
    '',
    '減完之後測試會再跑一次。不能為了減而讓功能壞掉。',
  ].join('\n')
}

function qaPrompt(card: Card, plan: string, results: TestResult[] | null): string {
  return [
    `## QA：${card.title}`,
    '',
    '測試已經跑過，結果如下 —— **「有沒有通過」不是你要回答的問題**。',
    '',
    '### 測試逐條結果',
    results
      ? results.map((r) => `- ${r.passed ? '✓' : '✗'} ${r.name}`).join('\n')
      : '（驗收指令沒有產出逐條結果）',
    '',
    '### 驗收條件（字面意思）',
    section(card, 'Acceptance Criteria'),
    '',
    '### 這次採用的做法',
    plan,
    '',
    '請看工作區裡的改動，回答：**這份產出符不符合要求？**',
    '特別留意有沒有靠改測試、加 stub、寫死回傳值來過關。',
  ].join('\n')
}

function replanPrompt(card: Card, failed: AttemptRecord, excluded: string[]): string {
  const rounds = failed.rounds
    .map((r) => {
      const fails = r.results?.filter((x) => !x.passed).map((x) => x.name) ?? []
      return [
        `輪 ${r.no}（${r.role}）：${r.verifySummary}`,
        fails.length ? `  沒過：${fails.join('、')}` : null,
        r.qa ? `  QA：${describeVerdict(r.qa)}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n')

  return [
    `## 重新規劃：${card.title}`,
    '',
    '上一個方案失敗了。你的工作是想出一個**真正不同**的做法 —— 不是上一個方案的變體。',
    '',
    '### 需求',
    section(card, 'Description'),
    '',
    '### 驗收條件',
    section(card, 'Acceptance Criteria'),
    '',
    '### 上一個方案',
    failed.plan,
    '',
    '### 它為什麼失敗',
    `判定：${failed.reason}`,
    '',
    rounds,
    '',
    '### 已排除的方案 —— 不要再提這些',
    excluded.join('\n\n'),
    '',
    '請直接輸出新的 Implementation Plan 本身（markdown），不要加前言或說明。',
    '要具體到 RD 拿了就能動手，但不要幫他把 code 寫出來。',
  ].join('\n')
}

// ── 寫回卡片 ─────────────────────────────────────────────────────────────

function formatExcluded(a: AttemptRecord): string {
  const fails =
    a.rounds[a.rounds.length - 1]?.results
      ?.filter((r) => !r.passed)
      .map((r) => r.name)
      .join('、') ?? ''
  return [
    `### 方案 ${a.no}（attempt-${a.no}，已排除）`,
    `**為什麼不行**：${a.reason}${fails ? `（過不了：${fails}）` : ''}`,
    `**分支**：\`${a.branch}\``,
    '',
    '<details><summary>當時的做法</summary>',
    '',
    a.plan,
    '',
    '</details>',
  ].join('\n')
}

/** 排除清單累積，不覆蓋 —— 它是 PM 換方案的依據，也是人判斷要不要繼續放手的材料。 */
async function appendExcluded(card: Card, excluded: string[]): Promise<void> {
  await upsertSection(card, 'Excluded Approaches', excluded.join('\n\n'))
}

async function writeNotes(card: Card, attempts: readonly AttemptRecord[]): Promise<void> {
  const blocks = attempts.map((a) => {
    const lines = [
      `**方案 ${a.no}（attempt-${a.no}）· ${endedLabel(a.ended)}**`,
      '',
      `- 分支：\`${a.branch}\``,
      `- 判定：${a.reason}`,
    ]
    for (const r of a.rounds) {
      lines.push(`- 輪 ${r.no}（${r.role}）：${r.verifySummary || '未跑到驗收'}`)
      const fails = r.results?.filter((x) => !x.passed) ?? []
      for (const f of fails) lines.push(`  - ✗ ${f.name}`)
      if (r.qa && r.qa.kind !== 'pass') lines.push(`  - QA：${describeVerdict(r.qa)}`)
    }
    lines.push(`- 花費：${a.cost ? `$${a.cost.toFixed(2)}` : '未取得'}`)
    return lines.join('\n')
  })
  await upsertSection(card, 'Implementation Notes', blocks.join('\n\n'))
}

function endedLabel(e: AttemptRecord['ended']): string {
  switch (e) {
    case 'passed':
      return '通過'
    case 'infeasible':
      return 'RD 回報方案不可行'
    case 'plan-inadequate':
      return 'QA 判定方案不足'
    case 'shape':
      return '失敗形狀顯示方案有問題'
    case 'rounds-exhausted':
      return '內層輪次用盡'
    case 'blocked':
      return '停手等決定'
    case 'error':
      return '執行錯誤'
  }
}

async function commit(repo: string, card: Card): Promise<void> {
  // 驗收與 QA 都過了才 commit，而且只在本機。push 已被 --disallowed-tools 擋死。
  await git(repo, ['add', '-A'])
  await git(repo, [
    '-c',
    'user.name=taskcrew',
    '-c',
    'user.email=noreply@localhost',
    'commit',
    '-m',
    `${card.id}: ${card.title}`,
  ])
}

// ── 小工具 ───────────────────────────────────────────────────────────────

function section(card: Card, name: string): string {
  return (card.sections[name] ?? '').replace(/<!--[\s\S]*?-->/g, '').trim() || '（無）'
}

/** 抓 `PREFIX: 內容` 這種第一行標記，回傳冒號後的內容。 */
function firstLine(text: string, prefix: string): string | null {
  const m = new RegExp(`^\\s*${prefix}:\\s*(.+)$`, 'm').exec(text)
  return m ? m[1].trim() : null
}
