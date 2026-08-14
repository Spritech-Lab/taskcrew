import { stripLeadingHeading, upsertSection } from './board.ts'
import { isRateLimited } from './claude.ts'
import { expandHome } from './gate.ts'
import type { Dispatcher } from './dispatch.ts'
import { describeVerdict, parseVerdict, type QaVerdict } from './qa.ts'
import { analyze, describe, shouldEscalate } from './shape.ts'
import { git } from './shell.ts'
import type { Autonomy, Card, TestResult } from './types.ts'
import { passed, scopeToCard, summarize, testRefs, verify } from './verify.ts'
import { mergeAll, settle } from './workspace.ts'

/**
 * 一張卡的完整產線。
 *
 *   內層 —— 實作沒寫對：junior 開發 → 測試 → senior 減法 → 測試 → QA
 *            沒過就由 senior 接手（保留 junior 的 code，路是對的）
 *
 *   中層 —— plan 有問題。兩個檔位，差別很大：
 *            · 修正：結構對、細節錯（例如假設的檔案不存在）
 *              同一條分支、同一個方案，只改細節，RD 接著做
 *            · 換方案：結構就錯
 *              新分支、從 base_branch 乾淨長出來，舊 code 一起丟
 *
 *   外層 —— 需求或方向不對：停下來，把球交回給人
 *
 * 「修正」這個檔位很重要：**多數失敗不是做法錯，是某個事實沒查證**。
 * 為了一個錯的檔名就把整個方案丟掉重來，是很貴的過度反應。
 */

/** 內層輪次上限。超過代表這不是機器自己能解決的實作問題。 */
const MAX_ROUNDS = 2

/** 同一個方案最多修正幾次。再多就代表問題不在細節，在結構。 */
const MAX_REVISIONS = 2

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
  /** 這個方案的第幾版 plan。修正會 +1；換方案則 attempt 進位、版本歸 1 */
  planVersion: number
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

/** PM 看完失敗之後的決定 */
export type PmDecision =
  /** 結構對、細節錯 —— 同分支同方案，只換 plan */
  | { kind: 'revise'; plan: string }
  /** 結構就錯 —— 換一個真正不同的做法 */
  | { kind: 'replace'; plan: string }
  /** 問題不在 plan，而是需求或驗收條件本身有洞 —— 交回人 */
  | { kind: 'handback'; reason: string }

export type PipelineResult =
  | { kind: 'done'; attempts: AttemptRecord[]; costUsd: number }
  | { kind: 'failed'; attempts: AttemptRecord[]; costUsd: number; reason: string }
  /** autonomy: propose —— PM 要換方案但不執行，卡退回「設計待批准」 */
  | { kind: 'proposed'; attempts: AttemptRecord[]; costUsd: number; newPlan: string }
  | { kind: 'rate-limited'; attempts: AttemptRecord[]; costUsd: number }

export interface PipelineOptions {
  /** agent 怎麼被叫起來（本機子行程或走匯流排），以及事件往哪送 */
  dispatch: Dispatcher
  /**
   * 分支從哪裡長出來。
   *
   * 通常是卡上的 base_branch，但**有依賴的卡要從被依賴的成果長出來** ——
   * 否則它拿不到自己依賴的東西，plan 裡寫的「呼叫 A 新加的函式」會找不到。
   */
  baseRef: string
  /**
   * 開工前要合進來的分支（父卡用）。
   *
   * 父卡的工作是整合，所以它的起點不是空的 —— 是所有子卡成果的合併。
   * agent 拿到的是一個已經合好（或有衝突待解）的工作區。
   */
  mergeRefs?: readonly string[]
}

export async function runPipeline(
  card: Card,
  opts: PipelineOptions,
): Promise<PipelineResult> {
  const repo = expandHome(card.runner!.project)
  try {
    return await run(card, opts)
  } finally {
    // 不管是通過、失敗、還是撞額度，repo 都要收回乾淨的起點。
    // 尤其是失敗那條路徑：沒 commit 的殘骸會被下一張卡的 checkout 帶走。
    const had = await settle(repo, card.runner!.base_branch)
    if (had) opts.dispatch.emit({ type: 'residue-committed', card: card.id })
  }
}

async function run(card: Card, opts: PipelineOptions): Promise<PipelineResult> {
  const cfg = card.runner!
  const repo = expandHome(cfg.project)
  const d = opts.dispatch

  const attempts: AttemptRecord[] = []
  const excluded: string[] = []
  let plan = section(card, 'Implementation Plan')
  let cost = 0

  const maxAttempts = attemptBudget(cfg.autonomy)

  for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
    const branch = `task/${card.id.toLowerCase()}-attempt-${attemptNo}`

    // 換方案 = 從 base_branch 乾淨長出來。舊方案的 code 不繼承 ——
    // 路走錯了，在爛攤子上改只會讓新方案變成舊方案的變體。
    const co = await git(repo, ['checkout', '-B', branch, opts.baseRef])
    if (co.code !== 0) {
      return {
        kind: 'failed',
        attempts,
        costUsd: cost,
        reason: `無法從 ${opts.baseRef} 建立分支 ${branch}：${co.stderr.trim()}`,
      }
    }
    d.emit({ type: 'attempt-start', card: card.id, attempt: attemptNo, branch })

    // 父卡：把子卡的成果合進來，agent 才有東西可以整合。
    // 衝突不自動解 —— 那是整合工作的一部分，交給 agent 在工作區裡處理。
    const merged = await mergeAll(repo, opts.mergeRefs ?? [])
    if (merged.conflicted) {
      d.emit({ type: 'merge-conflict', card: card.id, attempt: attemptNo, ref: merged.conflicted })
    }

    // ── 修正迴圈：同一個方案、同一條分支，只換 plan ──
    let planVersion = 1
    let pendingReplacement = ''

    // 換方案會把分支重設回 base_branch，所以每個角色記得的「我改過什麼」
    // 都變成假的 —— 那個世界已經不存在了。全部重置 session。
    const freshRoles = attemptNo > 1 ? new Set<'pm' | 'junior' | 'senior' | 'qa'>(['pm', 'junior', 'senior', 'qa']) : new Set<'pm' | 'junior' | 'senior' | 'qa'>()

    while (true) {
      const attempt = await runAttempt(card, repo, branch, plan, attemptNo, planVersion, d, freshRoles, opts.baseRef)
      attempts.push(attempt)
      cost += attempt.cost

      if (attempt.ended === 'passed') {
        await commit(repo, card, branch)
        await writeNotes(card, attempts)
        return { kind: 'done', attempts, costUsd: cost }
      }
      if (attempt.ended === 'blocked' || attempt.ended === 'error') {
        await writeNotes(card, attempts)
        return { kind: 'failed', attempts, costUsd: cost, reason: attempt.reason }
      }

      // 修正次數用完就不再問「該修還是該換」—— 改到第三版還不行，問題就不在細節
      if (planVersion > MAX_REVISIONS) {
        d.emit({ type: 'revisions-exhausted', card: card.id, attempt: attemptNo, max: MAX_REVISIONS })
        break
      }

      const pm = await askPm(d, card, attempt, excluded, repo, 'decide')
      cost += pm.cost
      if (pm.rateLimited) return { kind: 'rate-limited', attempts, costUsd: cost }
      if (!pm.decision) {
        await writeNotes(card, attempts)
        return { kind: 'failed', attempts, costUsd: cost, reason: 'PM 沒有給出可解析的決定' }
      }

      if (pm.decision.kind === 'handback') {
        // 交回人的理由是最該留在卡上的東西 —— 它說的是「需求本身有洞」，
        // 而那是只有你能修的，不是下次再跑一遍就會好的。
        await writeNotes(
          card,
          attempts,
          `**PM 交回人**\n\n${pm.decision.reason}\n\n換方案解決不了這個問題，需要你確認需求或驗收條件。`,
        )
        return {
          kind: 'failed',
          attempts,
          costUsd: cost,
          reason: `PM 交回人：${pm.decision.reason}`,
        }
      }

      if (pm.decision.kind === 'replace') {
        // 刻意不用 pm.decision.plan —— 那是在「記得自己剛才規劃了什麼」的
        // context 裡產出的，多半是原方案的變體。判斷可以帶著脈絡做，
        // 但替代方案要在乾淨的 session 裡重新想。
        pendingReplacement = ''
        break
      }

      // 修正：同分支、同 attempt，只有 plan 進版
      planVersion++
      plan = pm.decision.plan
      await upsertSection(card, 'Implementation Plan', plan)
      d.emit({ type: 'plan-revised', card: card.id, attempt: attemptNo, version: planVersion })
    }

    // ── 走到這裡代表要換方案 ──
    excluded.push(formatExcluded(attempts[attempts.length - 1]))
    await appendExcluded(card, excluded)

    if (attemptNo >= maxAttempts) break

    if (!pendingReplacement.trim()) {
      // 「修正次數用完」那條路徑還沒拿到新 plan，這裡才去要
      const pm = await askPm(d, card, attempts[attempts.length - 1], excluded, repo, 'force-replace')
      cost += pm.cost
      if (pm.rateLimited) return { kind: 'rate-limited', attempts, costUsd: cost }
      if (!pm.decision || pm.decision.kind === 'handback') {
        await writeNotes(card, attempts)
        return { kind: 'failed', attempts, costUsd: cost, reason: 'PM 無法產出新方案' }
      }
      pendingReplacement = pm.decision.plan
    }
    plan = pendingReplacement
    d.emit({ type: 'plan-replaced', card: card.id, attempt: attemptNo })

    // autonomy: propose —— 換方案改變的是「你批准過的做法」，所以要重新批准。
    // 修正不受此限：它只補細節，你批准的做法本身沒變。
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

/** 一個 plan 版本的內層循環：最多 MAX_ROUNDS 輪。 */
async function runAttempt(
  card: Card,
  repo: string,
  branch: string,
  plan: string,
  attemptNo: number,
  planVersion: number,
  d: Dispatcher,
  freshRoles: Set<'pm' | 'junior' | 'senior' | 'qa'>,
  /** 這張卡的起點。QA 只看相對於它的改動 */
  baseRef: string,
): Promise<AttemptRecord> {
  const cfg = card.runner!
  const at = { card: card.id, attempt: attemptNo, version: planVersion }
  const rec: AttemptRecord = {
    no: attemptNo,
    planVersion,
    branch,
    plan,
    rounds: [],
    ended: 'rounds-exhausted',
    reason: '',
    cost: 0,
  }

  for (let roundNo = 1; roundNo <= MAX_ROUNDS; roundNo++) {
    const isFirst = roundNo === 1
    const devRole = isFirst ? ('junior' as const) : ('senior' as const)
    const devSpec = d.describe(devRole)
    const round: RoundRecord = {
      no: roundNo,
      role: isFirst ? 'junior' : 'senior',
      results: null,
      verifySummary: '',
      qa: null,
      cost: 0,
    }
    rec.rounds.push(round)

    d.emit({ type: 'round-start', ...at, round: roundNo, role: devRole, ...devSpec })
    const devResult = await d.invoke(
      devRole,
      isFirst ? devPrompt(card, plan) : takeoverPrompt(card, plan, rec),
      repo,
      { fresh: takeFresh(freshRoles, devRole) },
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

    // RD 主動宣告方案不可行 —— 最快、最有價值的訊號，而且它通常帶著
    // 具體原因（檔案不存在、API 沒那個參數）。那種問題該用「修正」解決。
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

    const refs = testRefs(section(card, 'Acceptance Criteria'))
    let v = scopeToCard(await verify(cfg.verify, repo), refs).outcome
    round.results = v.results
    round.verifySummary = summarize(v)
    d.emit({ type: 'verify', ...at, round: roundNo, summary: round.verifySummary, passed: passed(v) })

    // 減法只在第一輪做 —— 第二輪的開發者就是 senior，他寫的時候已經在減了。
    if (isFirst && passed(v)) {
      d.emit({ type: 'reduce-start', ...at, round: roundNo })
      const reduce = await d.invoke('senior', reducePrompt(card, plan), repo, {
        fresh: takeFresh(freshRoles, 'senior'),
      })
      round.cost += reduce.costUsd ?? 0
      rec.cost += reduce.costUsd ?? 0
      if (isRateLimited(reduce)) {
        rec.ended = 'error'
        rec.reason = 'rate-limited'
        return rec
      }
      // 減法是修改，修改就要驗證。這是防止減過頭的唯一保險。
      v = scopeToCard(await verify(cfg.verify, repo), refs).outcome
      round.results = v.results
      round.verifySummary = summarize(v)
      d.emit({ type: 'verify', ...at, round: roundNo, summary: round.verifySummary, passed: passed(v), afterReduction: true })
    }

    const shape = analyze(rec.rounds.map((r) => r.results))

    if (passed(v)) {
      d.emit({ type: 'qa-start', ...at, round: roundNo })
      const diff = await changedSince(repo, baseRef)
      const qaResult = await d.invoke('qa', qaPrompt(card, plan, v.results, diff), repo, {
        fresh: takeFresh(freshRoles, 'qa'),
      })
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
      d.emit({ type: 'qa-reject', ...at, round: roundNo, detail: describeVerdict(verdict) })
      continue
    }

    if (shouldEscalate(shape)) {
      rec.ended = 'shape'
      rec.reason = describe(shape)
      return rec
    }
    d.emit({ type: 'stay-inner', ...at, round: roundNo, shape: describe(shape) })
  }

  rec.ended = 'rounds-exhausted'
  rec.reason = `內層 ${MAX_ROUNDS} 輪用盡仍未通過`
  return rec
}

// ── PM：修正、換方案，還是交回人 ────────────────────────────────────────

async function askPm(
  d: Dispatcher,
  card: Card,
  failed: AttemptRecord,
  excluded: readonly string[],
  repo: string,
  mode: 'decide' | 'force-replace',
): Promise<{ decision: PmDecision | null; cost: number; rateLimited: boolean }> {
  const r = await d.invoke('pm', pmPrompt(card, failed, excluded, mode), repo, {
    // 判斷「該修正還是該換方案」需要記得自己規劃了什麼；
    // 產出替代方案則相反 —— 要的正是不被自己的思路拉住。
    fresh: mode === 'force-replace',
  })
  const cost = r.costUsd ?? 0
  if (isRateLimited(r)) return { decision: null, cost, rateLimited: true }
  if (!r.ok) return { decision: null, cost, rateLimited: false }
  return { decision: parsePmDecision(r.text, mode), cost, rateLimited: false }
}

/**
 * PM 必須在第一行明說走哪一條 —— 兩條路在分支與 code 的處理上完全相反，
 * 猜錯的代價是把一份大致正確的方案連同它的成果一起丟掉。
 */
export function parsePmDecision(
  text: string,
  mode: 'decide' | 'force-replace' = 'decide',
): PmDecision | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const m = /^[*#>\-\s]*(REVISE|REPLACE|HANDBACK)\s*[:：]?[ \t]*(.*)$/im.exec(trimmed)
  if (!m) {
    // force-replace 模式下 PM 只要吐 plan，不需要標頭
    return mode === 'force-replace'
      ? { kind: 'replace', plan: stripLeadingHeading(trimmed, 'Implementation Plan') }
      : null
  }

  const keyword = m[1].toUpperCase()
  if (keyword === 'HANDBACK') {
    return { kind: 'handback', reason: (m[2] || '').trim() || '（未說明）' }
  }

  // 標頭之後的所有內容就是 plan（標頭同一行的殘餘也算進去）
  const after = trimmed.slice(m.index + m[0].length)
  const plan = stripLeadingHeading(`${(m[2] || '').trim()}\n${after}`.trim(), 'Implementation Plan')

  // REPLACE 不需要附方案 —— 替代方案會在乾淨的 session 裡另外問。
  // 要求 PM 在這裡寫一份注定被丟掉的 plan 是純粹的浪費。
  if (keyword === 'REPLACE') return { kind: 'replace', plan }
  if (!plan) return null
  return { kind: 'revise', plan }
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

/**
 * 這次改動的 diff（相對於卡片的起點）。
 *
 * QA 只該看這個，不該看整個 repo —— 它曾經把**既有的**問題算到這次改動頭上，
 * 把一張其實修好了那個問題的卡片退回兩輪。（實跑：agent 移除了迴圈裡多餘的
 * `subscribeAlerts()`，QA 卻說它加上去的。）
 *
 * 太長就截斷並說明 —— 塞爆提示只會讓整輪失敗，而看不完的 diff 本來就代表
 * 這張卡太大了。
 */
async function changedSince(repo: string, baseRef: string): Promise<string> {
  const r = await git(repo, ['diff', baseRef, '--', '.'])
  if (r.code !== 0) return '（拿不到 diff）'
  const MAX = 60_000
  if (r.stdout.length <= MAX) return r.stdout
  return `${r.stdout.slice(0, MAX)}\n\n…（diff 太長已截斷，只顯示前 ${MAX} 字）`
}

function qaPrompt(
  card: Card,
  plan: string,
  results: TestResult[] | null,
  diff: string,
): string {
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
    '### 這次的改動（相對於這張卡的起點）',
    '',
    '```diff',
    diff,
    '```',
    '',
    '回答：**這份改動符不符合要求？**',
    '',
    '**只評判上面這份 diff。** repo 裡其他地方的問題不是這張卡的責任 ——',
    '把既有的問題算到這次改動頭上，會讓一張其實修好了問題的卡被退回。',
    '要指出哪裡有問題時，**引用 diff 裡的實際內容**，不要只給行號。',
    '',
    '特別留意有沒有靠改測試、加 stub、寫死回傳值來過關。',
  ].join('\n')
}

function pmPrompt(
  card: Card,
  failed: AttemptRecord,
  excluded: readonly string[],
  mode: 'decide' | 'force-replace',
): string {
  const rounds = failed.rounds
    .map((r) => {
      const fails = r.results?.filter((x) => !x.passed).map((x) => x.name) ?? []
      return [
        `輪 ${r.no}（${r.role}）：${r.verifySummary || '未跑到驗收'}`,
        fails.length ? `  沒過：${fails.join('、')}` : null,
        r.qa ? `  QA：${describeVerdict(r.qa)}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n')

  const head =
    mode === 'force-replace'
      ? [
          `## 換方案：${card.title}`,
          '',
          '這個方案已經修正過多次仍不通過，代表問題不在細節而在結構。',
          '請直接輸出一個**真正不同**的做法（markdown），不要加前言、不要加標頭。',
        ]
      : [
          `## 這個方案沒通過：${card.title}`,
          '',
          '判斷問題出在哪一層。**第一行必須是下列三者之一**：',
          '',
          '`REVISE:` —— **結構是對的，只是某個細節錯了。**',
          '  典型情況：假設的檔案不存在、API 沒有那個參數、漏掉一個步驟、',
          '  某個事實當初沒查證清楚。這條路會保留現有分支與成果，RD 接著做。',
          '  標頭之後直接接**修正過的完整 plan**。',
          '',
          '`REPLACE:` —— **做法本身錯了**，細節怎麼補都到不了。',
          '  這條路會丟掉現有的 code，從頭來過。',
          '  標頭之後**只要說明為什麼結構有問題**，不用寫替代方案 ——',
          '  那會在一個乾淨的 session 裡另外問你，免得新方案變成舊方案的變體。',
          '',
          '`HANDBACK:` —— **問題不在 plan**，是需求或驗收條件本身有洞。',
          '  標頭之後說明你需要人確認什麼。換多少方案都解不了的情況請選這個。',
          '',
          '**先看失敗的性質再決定。多數失敗是某個事實沒查證，不是做法錯** ——',
          '為了一個錯的檔名就把整個方案連同已完成的工作一起丟掉，是很貴的過度反應。',
        ]

  return [
    ...head,
    '',
    '### 需求',
    section(card, 'Description'),
    '',
    '### 驗收條件',
    section(card, 'Acceptance Criteria'),
    '',
    `### 目前的做法（第 ${failed.planVersion} 版）`,
    failed.plan,
    '',
    '### 它為什麼沒通過',
    `判定：${failed.reason}`,
    '',
    rounds,
    ...(excluded.length
      ? ['', '### 已排除的方案 —— 不要再提這些', excluded.join('\n\n')]
      : []),
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
    a.planVersion > 1 ? `**修正過 ${a.planVersion - 1} 次仍不通過**` : null,
    `**分支**：\`${a.branch}\``,
    '',
    '<details><summary>當時的做法</summary>',
    '',
    a.plan,
    '',
    '</details>',
  ]
    .filter((l) => l !== null)
    .join('\n')
}

/**
 * 排除清單只記**換掉的方案**，不記修正。
 * 把每次微調都塞進來，PM 下次讀它時反而找不到重點。
 */
async function appendExcluded(card: Card, excluded: readonly string[]): Promise<void> {
  await upsertSection(card, 'Excluded Approaches', excluded.join('\n\n'))
}

async function writeNotes(
  card: Card,
  attempts: readonly AttemptRecord[],
  extra?: string,
): Promise<void> {
  const blocks = attempts.map((a) => {
    const label = a.planVersion === 1 ? `方案 ${a.no}` : `方案 ${a.no} · plan v${a.planVersion}`
    const lines = [
      `**${label}（attempt-${a.no}）· ${endedLabel(a.ended)}**`,
      '',
      `- 分支：\`${a.branch}\``,
      `- 判定：${a.reason}`,
    ]
    for (const r of a.rounds) {
      lines.push(`- 輪 ${r.no}（${r.role}）：${r.verifySummary || '未跑到驗收'}`)
      for (const f of r.results?.filter((x) => !x.passed) ?? []) lines.push(`  - ✗ ${f.name}`)
      if (r.qa && r.qa.kind !== 'pass') lines.push(`  - QA：${describeVerdict(r.qa)}`)
    }
    lines.push(`- 花費：${a.cost ? `$${a.cost.toFixed(2)}` : '未取得'}`)
    return lines.join('\n')
  })
  if (extra) blocks.push(extra)
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

// ── autonomy ────────────────────────────────────────────────────────────

function attemptBudget(a: Autonomy): number {
  switch (a.kind) {
    case 'none':
      return 1
    case 'propose':
      // 跑一個方案；要**換方案**時 PM 產出但不執行，卡退回等你批准。
      // 修正不受影響 —— 它只補細節，你批准的做法本身沒變。
      return 2
    case 'replan':
      return a.max + 1
    case 'free':
      return Number.MAX_SAFE_INTEGER
  }
}

async function commit(repo: string, card: Card, branch: string): Promise<void> {
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

  // 通過的成果額外指到一個**穩定的分支名**。
  //
  // attempt 分支的編號會變（換方案就 +1），但依賴這張卡的後續工作、
  // 以及父卡的整合，都需要一個「這張卡最後被接受的成果」的固定名字。
  // 沒有它，下游只能猜第幾個 attempt 才是對的。
  await git(repo, ['branch', '-f', acceptedBranch(card.id), branch])
}

/** 一張卡最後被接受的成果。跟 attempt 分支不同 —— 這個名字不會變。 */
export function acceptedBranch(cardId: string): string {
  return `task/${cardId.toLowerCase()}`
}

function section(card: Card, name: string): string {
  return (card.sections[name] ?? '').replace(/<!--[\s\S]*?-->/g, '').trim() || '（無）'
}

/**
 * 取出並消費一次「這個角色需要重置 session」的標記。
 * 只有換方案後的第一次呼叫要重置，之後同一個 attempt 內要延續。
 */
function takeFresh(
  freshRoles: Set<'pm' | 'junior' | 'senior' | 'qa'>,
  role: 'pm' | 'junior' | 'senior' | 'qa',
): boolean {
  if (!freshRoles.has(role)) return false
  freshRoles.delete(role)
  return true
}

/** 抓 `PREFIX: 內容` 這種第一行標記，回傳冒號後的內容。 */
function firstLine(text: string, prefix: string): string | null {
  const m = new RegExp(`^\\s*${prefix}:\\s*(.+)$`, 'm').exec(text)
  return m ? m[1].trim() : null
}
