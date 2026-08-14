import { runShell } from './shell.ts'
import type { TestResult, VerifyOutcome } from './types.ts'

/**
 * 跑卡片上的 verify 指令。
 *
 * 為什麼堅持要逐條結果、而不是只看 exit code：**跨輪比較逐條結果的變化**是
 * 分辨「實作沒寫對」和「方案本身不對」的唯一客觀依據（設計文件 §9.1）。
 * 只有一個布林值的話，就只能靠 agent 主觀判斷 —— 那正是要避免的。
 */
export async function verify(
  command: string,
  cwd: string,
  timeoutMs = 10 * 60_000,
): Promise<VerifyOutcome> {
  const r = await runShell(command, { cwd, timeoutMs })
  return {
    exitCode: r.code,
    results: parseResults(r.stdout) ?? parseResults(r.stderr),
    stdout: r.stdout,
    stderr: r.stderr,
  }
}

/**
 * 從測試輸出裡撈逐條結果。
 *
 * 目前只認得幾種常見的 JSON 格式。認不出來時回傳 null —— 呼叫端會退化成
 * 只看 exit code，並且該讓使用者知道這張卡失去了失敗分類的能力。
 * 寧可明確地說「解析不出來」，也不要猜一個假的逐條結果。
 */
function parseResults(output: string): TestResult[] | null {
  const json = extractJson(output)
  if (!json) return null

  // node --test / vitest / jest 之類的 JSON reporter，形狀各異，
  // 這裡認幾個常見的欄位命名。
  const candidates: unknown[] =
    (json as any).testResults ??
    (json as any).tests ??
    (json as any).assertionResults ??
    (Array.isArray(json) ? json : [])

  if (!Array.isArray(candidates) || candidates.length === 0) return null

  const out: TestResult[] = []
  for (const c of candidates) {
    if (typeof c !== 'object' || c === null) continue
    const o = c as Record<string, unknown>
    const name = o.fullName ?? o.name ?? o.title ?? o.testPath
    const status = o.status ?? o.state ?? o.result
    if (typeof name !== 'string') continue
    out.push({
      name,
      passed:
        o.passed === true ||
        status === 'passed' ||
        status === 'pass' ||
        status === 'ok',
    })
  }
  return out.length > 0 ? out : null
}

function extractJson(s: string): unknown {
  const t = s.trim()
  if (!t) return null
  // 測試工具常在 JSON 前後夾雜文字，抓最外層的 {...} 或 [...]
  const start = t.search(/[[{]/)
  if (start < 0) return null
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'))
  if (end <= start) return null
  try {
    return JSON.parse(t.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * 只保留這張卡的驗收條件涵蓋到的測試。
 *
 * 同一個 repo 的多張卡共用一套測試指令，所以整套結果裡會有**別張卡的**
 * 失敗項。不過濾的話，兩張卡會互相擋住對方 —— 每張卡都因為別人的測試沒過
 * 而永遠無法通過，而 agent 為了讓測試變綠就會被迫越界去改不屬於它的檔案。
 *
 * 實跑時真的發生過：senior 停下來回報「我在既定範圍內無事可做，但測試也不會綠」。
 * 它的判斷是對的，錯的是我讓它面對整套測試。
 */
export function scopeToCard(
  o: VerifyOutcome,
  refs: readonly string[],
): { outcome: VerifyOutcome; matched: number } {
  if (!o.results || refs.length === 0) return { outcome: o, matched: 0 }

  const wanted = refs.map(normalizeRef).filter(Boolean)
  const kept = o.results.filter((r) => wanted.some((w) => matches(r.name, w)))

  // 一條都對不上代表驗收條件引用的測試不存在 —— 那時候用整套結果比較安全，
  // 呼叫端會看到 matched=0 並據此警告。悄悄放行是最糟的選項。
  if (kept.length === 0) return { outcome: o, matched: 0 }

  return {
    outcome: { ...o, results: kept, exitCode: kept.every((r) => r.passed) ? 0 : 1 },
    matched: kept.length,
  }
}

/** `test/run.js::slug-lowercases` → `slug-lowercases`；沒有 :: 就用整串 */
export function normalizeRef(ref: string): string {
  const s = ref.replace(/[`'"]/g, '').trim()
  const i = s.lastIndexOf('::')
  return (i >= 0 ? s.slice(i + 2) : s).trim()
}

function matches(testName: string, ref: string): boolean {
  const a = testName.toLowerCase()
  const b = ref.toLowerCase()
  return a === b || a.includes(b) || b.includes(a)
}

/** 從 Acceptance Criteria 的每一條裡抓出 `→` 之後的測試引用。 */
export function testRefs(acceptanceCriteria: string): string[] {
  const out: string[] = []
  for (const line of acceptanceCriteria.split('\n')) {
    const m = /→\s*(.+?)\s*$/.exec(line)
    if (m) out.push(m[1])
  }
  return out
}

/** verify 過了沒。有逐條結果時以逐條為準，否則退回 exit code。 */
export function passed(o: VerifyOutcome): boolean {
  if (o.results) return o.results.every((r) => r.passed)
  return o.exitCode === 0
}

export function summarize(o: VerifyOutcome): string {
  if (!o.results) return o.exitCode === 0 ? '通過（僅 exit code）' : `失敗（exit ${o.exitCode}）`
  const pass = o.results.filter((r) => r.passed).length
  return `${pass}/${o.results.length} 通過`
}
