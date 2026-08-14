import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { git } from './shell.ts'
import { isFileRef, normalizeRef, splitRefs, testRefs, verify } from './verify.ts'
import type { Card } from './types.ts'

/**
 * 閘門：卡從「設計待批准」移往「待執行」時的七項檢查。
 *
 * 這是整套系統唯一保證卡片品質的地方 —— 入口刻意不設限（誰都能建卡：對話、
 * Discord、web UI、別人寫的腳本），所以品質全部押在這裡。
 */

/** 這些區塊裡不該留著 `taskcrew new` 的佔位文字 */
const PLACEHOLDER_SECTIONS = [
  'Runner Config',
  'Description',
  'Acceptance Criteria',
  'Implementation Plan',
] as const

export type GateVerdict =
  /** 七項全過，可以進 queue */
  | { kind: 'pass' }
  /** 依賴還沒完成 —— 不是不合格，是還沒輪到。卡應轉入「阻塞」 */
  | { kind: 'blocked'; waitingOn: string[] }
  /** 有欄位不合格。卡留在原處，訊息告訴人要補什麼 */
  | { kind: 'fail'; problems: string[] }

/**
 * 驗收條件引用了、但實際跑不出來的測試名。
 *
 * 跑一次 verify 拿到真實的測試清單再比對。慢，但只在卡片進 queue 時發生一次，
 * 而它擋掉的是「卡片永遠過不了而且看不出原因」那種最難查的狀況。
 *
 * verify 本身跑不起來（指令錯、repo 壞）時回空陣列 —— 那是別的檢查的事，
 * 不要在這裡多報一次。
 */
export async function missingTestRefs(
  card: Card,
  repo: string,
  verifyCmd: string,
): Promise<string[]> {
  const refs = testRefs(card.sections['Acceptance Criteria'] ?? '')
  if (refs.length === 0) return []

  const outcome = await verify(verifyCmd, repo)
  if (!outcome.results || outcome.results.length === 0) return []

  const names = outcome.results.map((r) => r.name.toLowerCase())
  const missing: string[] = []
  for (const raw of refs) {
    for (const ref of splitRefs(raw)) {
      // 整個檔案的引用（例如 `test/news.test.ts`）不比對測試名 —— 那是刻意的
      // 用法：引用前面卡片的測試檔，防止 agent 改壞舊的產出。
      if (isFileRef(ref)) continue
      const want = normalizeRef(ref)
      if (!want) continue
      if (!names.some((n) => n === want || n.includes(want) || want.includes(n))) {
        missing.push(want)
      }
    }
  }
  return missing
}

export async function checkGate(
  card: Card,
  allCards: readonly Card[],
): Promise<GateVerdict> {
  const problems: string[] = []

  const runner = card.runner
  if (!runner) {
    problems.push(
      '缺少可解析的 `## Runner Config` 區塊（需要 project、base_branch、verify、autonomy 四個欄位）',
    )
  }

  if (runner) {
    // 1. 目標 repo 存在
    const project = expandHome(runner.project)
    if (!(await exists(project))) {
      problems.push(`project 指向的目錄不存在：${runner.project}`)
    } else if (!(await exists(resolve(project, '.git')))) {
      problems.push(`project 不是 git repo：${runner.project}`)
    } else {
      // 2. 起點分支存在（只在 repo 確實存在時才有意義）
      const r = await git(project, ['rev-parse', '--verify', runner.base_branch])
      if (r.code !== 0) {
        problems.push(`base_branch 在 repo 裡找不到：${runner.base_branch}`)
      }
    }

    // 5. verify 非空
    if (!runner.verify.trim()) {
      problems.push('verify 是空的 —— 寫不出驗收指令，代表成功定義還沒被講清楚')
    }
  }

  // 3. Description 必須有「不要做什麼」
  const description = card.sections['Description'] ?? ''
  if (!/\*\*不要做什麼\*\*/.test(description)) {
    problems.push('Description 缺少「不要做什麼」段落 —— 無人看管時這段擋掉的災難最多')
  }

  // 4. 每條驗收條件都要掛對應的 test case
  const acProblems = checkAcceptanceCriteria(card.sections['Acceptance Criteria'] ?? '')
  problems.push(...acProblems)

  // 4b. 而且那些 test case 要**真的存在**。
  //
  // 測試名是人手打進驗收條件的，打錯一個字 `scopeToCard` 就對不上，於是
  // 悄悄退回整套測試 —— 那張卡從此被別張卡的紅字綁住，永遠過不了，
  // 而錯誤訊息完全看不出原因。這是建卡時就該發現的事。
  if (runner && acProblems.length === 0) {
    const missing = await missingTestRefs(card, expandHome(runner.project), runner.verify)
    if (missing.length > 0) {
      problems.push(`驗收條件引用了不存在的測試：${missing.join('、')}`)
    }
  }

  // 6. Implementation Plan 非空（卡被移出「設計待批准」本身就是批准，不需要額外的 approved 欄位）
  if (!stripMarkers(card.sections['Implementation Plan'] ?? '').trim()) {
    problems.push('Implementation Plan 是空的 —— PM 還沒產出做法')
  }

  // 8. 骨架的佔位文字還在
  //
  // `taskcrew new` 產出的佔位文字全部包在 ⟨⟩ 裡。留著就代表這張卡還沒填完。
  //
  // 這一項的存在是因為佔位文字**自己會滿足其他檢查** —— 「不要做什麼」那段的
  // 說明裡就寫著 `**不要做什麼**`，驗收條件的範本裡就有 `→ 測試引用`。
  // 沒有這一項的話，一張完全沒填的卡會被判合格，agent 拿到「⟨具體、可驗證的
  // 描述⟩」當需求，然後對著一個不存在的測試名工作。
  //
  // 它擋的主要不是人，是**建卡的 agent**：需求裡沒講驗收怎麼測時，正確的行為
  // 是把它留白讓這裡擋下來，而不是自己編一個測試名。
  const unfilled = PLACEHOLDER_SECTIONS.filter((name) =>
    (card.sections[name] ?? '').includes('⟨'),
  )
  if (unfilled.length > 0) {
    problems.push(`還有沒填完的欄位（⟨⟩ 裡的佔位文字）：${unfilled.join('、')}`)
  }

  if (problems.length > 0) return { kind: 'fail', problems }

  // 7. 依賴與子卡 —— 放在最後，因為「還沒輪到」跟「不合格」是兩回事
  const waitingOn = await notReady(card, allCards)
  if (waitingOn.length > 0) return { kind: 'blocked', waitingOn }

  return { kind: 'pass' }
}

/**
 * 這張卡在等誰。
 *
 * 「依賴」和「子卡」是同一件事的兩種形狀 —— 都是**這張卡要建立在別人的產出上**。
 * 依賴是「我要用你做出來的東西」，子卡是「我要把你們做出來的東西合起來」。
 * 兩者都得等上游真的產出成果，所以用同一條規則。
 *
 * 規劃和執行也共用這個判斷。理由一樣：plan 若寫在一個上游還不存在的世界裡，
 * 那份 plan 只能是猜的，而**你批准一份猜測等於沒有審查**。
 */
export async function notReady(card: Card, allCards: readonly Card[]): Promise<string[]> {
  const byId = new Map(allCards.map((c) => [c.id, c]))
  const upstream = [...card.dependencies.map((id) => byId.get(id) ?? id), ...children(card, allCards)]

  const out: string[] = []
  for (const u of upstream) {
    if (typeof u === 'string') {
      out.push(u) // 依賴指向一張不存在的卡
    } else if (!(await satisfiesDownstream(u))) {
      out.push(u.id)
    }
  }
  return [...new Set(out)]
}

/**
 * 這張卡是否已經可以讓下游（依賴它的卡、以它為子卡的父卡）開工。
 *
 * 預設「執行完成回報 + 有成果分支」就算數 —— 那代表測試逐條過了、QA 也過了，
 * 介面是真的、能被下游 import。**不預設等人**，因為一條四張卡的依賴鏈會變成
 * 要人醒來四次，那讓無人看管執行整個失去意義。
 *
 * 為什麼要多看一次分支：**失敗的卡也停在「執行完成回報」**（那一欄的意思是
 * 「球在你手上」，不是「成功了」）。成果分支只在產線通過時才會被指過去，
 * 所以它是「這張卡真的產出了可用的東西」唯一機械可查的證據。
 *
 * 「完成」則不查分支 —— 那是你親口說的，而且看板可以手動拖，一張沒跑過的卡
 * 被拖到完成是正常情境（runner 會退回 base_branch 並發出 missing-ref）。
 */
export async function satisfiesDownstream(card: Card): Promise<boolean> {
  if (card.status === '完成') return true
  if (card.status !== '執行完成回報') return false
  if (card.runner?.require_review) return false
  if (!card.runner) return false
  const repo = expandHome(card.runner.project)
  return (
    await git(repo, ['rev-parse', '--verify', '--quiet', `task/${card.id.toLowerCase()}`])
  ).code === 0
}

/**
 * 驗收條件必須逐條掛測試。
 *
 * 這比「判斷這條夠不夠可驗證」可靠得多 —— 前者機械可檢查，後者靠感覺。
 * 寫不出對應測試的條件，就不是驗收條件，是願望。
 */
function checkAcceptanceCriteria(section: string): string[] {
  const body = stripMarkers(section)
  const items = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^-\s*\[[ x]\]/i.test(l))

  if (items.length === 0) return ['Acceptance Criteria 是空的']

  const unlinked = items.filter((l) => !/→\s*\S/.test(l))
  if (unlinked.length > 0) {
    return [
      `有 ${unlinked.length} 條驗收條件沒有掛對應的 test case（格式：\`→ path/to/test::case\`）：\n` +
        unlinked.map((l) => `      ${l}`).join('\n'),
    ]
  }
  return []
}

/** 去掉 Backlog.md 的 HTML 區塊標記，只留內容。 */
function stripMarkers(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, '')
}

/** 這張卡的直接子卡。只允許兩層，所以不需要遞迴。 */
export function children(card: Card, all: readonly Card[]): Card[] {
  return all.filter((c) => c.parentTaskId === card.id)
}

export function expandHome(p: string): string {
  return p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : resolve(p)
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}
