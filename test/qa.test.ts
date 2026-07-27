import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseVerdict } from '../src/qa.ts'

/**
 * 這些案例不是假想的 —— 第一次實跑時 QA 回了 `**符合要求**`，
 * 而當時的解析器只比對 `^符合要求`，判定失敗、白跑一輪最貴的 senior。
 * 錯誤的嚴格比放寬更花錢。
 */

test('裸的判定', () => {
  assert.deepEqual(parseVerdict('符合要求'), { kind: 'pass' })
})

test('帶 markdown 粗體（實跑時真的發生過）', () => {
  assert.deepEqual(parseVerdict('**符合要求**\n\n實作正確忠實於建議做法…'), { kind: 'pass' })
})

test('帶標題符號', () => {
  assert.deepEqual(parseVerdict('## 符合要求'), { kind: 'pass' })
})

test('帶清單符號', () => {
  assert.deepEqual(parseVerdict('- 符合要求'), { kind: 'pass' })
})

test('IMPLEMENTATION_BUG 留內層', () => {
  const v = parseVerdict('IMPLEMENTATION_BUG: 邊界值沒處理')
  assert.equal(v.kind, 'implementation-bug')
  assert.equal(v.kind === 'implementation-bug' && v.detail, '邊界值沒處理')
})

test('PLAN_INADEQUATE 升中層', () => {
  const v = parseVerdict('**PLAN_INADEQUATE**：這個做法達不到第三條')
  assert.equal(v.kind, 'plan-inadequate')
})

test('判定前有空行也認得', () => {
  assert.deepEqual(parseVerdict('\n\n符合要求\n'), { kind: 'pass' })
})

test('關鍵字埋在解釋文字深處不算判定', () => {
  const v = parseVerdict('第一行\n第二行\n第三行\n第四行\n符合要求')
  assert.equal(v.kind, 'unparsed')
})

test('完全沒照格式 → unparsed，不猜', () => {
  assert.equal(parseVerdict('看起來還行吧').kind, 'unparsed')
})

// ── PM 的決定 ──────────────────────────────────────────────────────────

test('PM 決定：REVISE 帶新 plan', async () => {
  const { parsePmDecision } = await import('../src/pipeline.ts')
  const d = parsePmDecision('REVISE: 檔案應該是 slug.js\n\n改成在 slug.js 裡做')
  assert.equal(d?.kind, 'revise')
  assert.match(d && 'plan' in d ? d.plan : '', /slug\.js/)
})

test('PM 決定：REPLACE', async () => {
  const { parsePmDecision } = await import('../src/pipeline.ts')
  const d = parsePmDecision('REPLACE:\n\n改用完全不同的做法')
  assert.equal(d?.kind, 'replace')
})

test('PM 決定：HANDBACK 帶原因', async () => {
  const { parsePmDecision } = await import('../src/pipeline.ts')
  const d = parsePmDecision('HANDBACK: 驗收條件第 2 與第 3 條互相矛盾')
  assert.equal(d?.kind, 'handback')
  assert.match(d && 'reason' in d ? d.reason : '', /矛盾/)
})

test('PM 決定：帶 markdown 裝飾也認得', async () => {
  const { parsePmDecision } = await import('../src/pipeline.ts')
  assert.equal(parsePmDecision('**REVISE：** 細節修正\n\n新 plan')?.kind, 'revise')
  assert.equal(parsePmDecision('## REPLACE\n\n新做法')?.kind, 'replace')
})

test('PM 沒給標頭 → decide 模式判定失敗，不猜', async () => {
  const { parsePmDecision } = await import('../src/pipeline.ts')
  assert.equal(parsePmDecision('我覺得應該改一下做法'), null)
})

test('force-replace 模式下不需要標頭', async () => {
  const { parsePmDecision } = await import('../src/pipeline.ts')
  const d = parsePmDecision('新的做法內容', 'force-replace')
  assert.equal(d?.kind, 'replace')
})
