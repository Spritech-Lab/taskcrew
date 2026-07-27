import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyze, shouldEscalate } from '../src/shape.ts'
import type { TestResult } from '../src/types.ts'

/** `a` = 過，`x` = 掛。位置就是測試名稱，方便寫出「同一批」與「換一批」的差別。 */
function round(pattern: string): TestResult[] {
  return [...pattern].map((c, i) => ({ name: `t${i}`, passed: c === 'a' }))
}

test('全過 → passing', () => {
  assert.equal(analyze([round('aaa')]), 'passing')
})

test('第一輪就幾乎全掛 → all-failing，不必等第二輪', () => {
  assert.equal(analyze([round('xxxxx')]), 'all-failing')
  assert.equal(shouldEscalate('all-failing'), true)
})

test('第一輪只掛一部分 → unknown（資訊不足，先讓它再試一輪）', () => {
  assert.equal(analyze([round('aaxx')]), 'unknown')
  assert.equal(shouldEscalate('unknown'), false)
})

test('失敗數減少 → converging，留內層', () => {
  assert.equal(analyze([round('axxx'), round('aaxx')]), 'converging')
  assert.equal(shouldEscalate('converging'), false)
})

test('同一批一直掛、數量沒動 → stuck，升中層', () => {
  assert.equal(analyze([round('aaxx'), round('aaxx')]), 'stuck')
  assert.equal(shouldEscalate('stuck'), true)
})

test('修好一批又弄壞另一批 → oscillating，升中層', () => {
  // t2/t3 修好了，但 t0/t1 壞了 —— 東牆補西牆
  assert.equal(analyze([round('aaxx'), round('xxaa')]), 'oscillating')
  assert.equal(shouldEscalate('oscillating'), true)
})

test('總數相同但只要有回歸就算震盪，不會被誤判成 stuck', () => {
  assert.equal(analyze([round('aax'), round('axa')]), 'oscillating')
})

test('沒有逐條結果 → unknown，不亂猜', () => {
  assert.equal(analyze([null, null]), 'unknown')
})

test('部分輪次沒有逐條結果時，只用拿得到的那幾輪判定', () => {
  assert.equal(analyze([round('axxx'), null, round('aaxx')]), 'converging')
})

test('空的結果陣列不會被當成「全過」', () => {
  assert.equal(analyze([[]]), 'unknown')
})
