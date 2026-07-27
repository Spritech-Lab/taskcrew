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
