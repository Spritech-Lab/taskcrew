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

// ── 驗收範圍 ────────────────────────────────────────────────────────────

test('驗收只看這張卡涵蓋的測試 —— 否則多張卡會互相擋住', async () => {
  const { scopeToCard, testRefs, passed } = await import('../src/verify.ts')

  const whole = {
    exitCode: 1,
    stdout: '',
    stderr: '',
    results: [
      { name: 'slug-lowercases', passed: true },
      { name: 'slug-spaces', passed: true },
      { name: 'initials-single', passed: false }, // 別張卡的工作
      { name: 'initials-two', passed: false },
    ],
  }
  const refs = testRefs('- [ ] #1 x → `test/run.js::slug-lowercases`\n- [ ] #2 y → `test/run.js::slug-spaces`')

  const { outcome, matched } = scopeToCard(whole, refs)
  assert.equal(matched, 2)
  assert.equal(passed(outcome), true, '這張卡自己的測試都過了就該算過')
  assert.equal(passed(whole), false, '整套結果仍然是失敗的 —— 那是別張卡的事')
})

test('驗收條件引用的測試一條都對不上時，退回整套結果並回報 matched=0', async () => {
  const { scopeToCard } = await import('../src/verify.ts')
  const whole = {
    exitCode: 1,
    stdout: '',
    stderr: '',
    results: [{ name: 'a', passed: false }],
  }
  const { outcome, matched } = scopeToCard(whole, ['completely-different'])
  assert.equal(matched, 0, '對不上要讓呼叫端知道')
  assert.equal(outcome.results?.length, 1, '悄悄放行是最糟的選項 —— 用整套結果比較安全')
})

test('抓得出 → 後面的測試引用', async () => {
  const { testRefs } = await import('../src/verify.ts')
  assert.deepEqual(
    testRefs('- [ ] #1 空白轉連字號 → `test/run.js::spaces-to-dashes`\n- [ ] #2 沒有引用的一條'),
    ['`test/run.js::spaces-to-dashes`'],
  )
})
