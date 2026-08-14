import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isRateLimited, type AgentResult } from '../src/claude.ts'

/**
 * 撞限判定。
 *
 * 這是整套系統唯一的正常煞車（設計文件 §7.3），所以它是承重路徑 ——
 * 但**誤判的代價比漏判高**：誤判會丟掉已經產出的成果，然後回報一個
 * 不存在的原因，讓人以為額度沒了而停手。
 */

const base: AgentResult = {
  ok: true,
  text: '',
  sessionId: 's',
  costUsd: 0.5,
  exitCode: 0,
  apiErrorStatus: null,
  errors: [],
  raw: '',
}

test('plan 裡提到 API 的 rate limit 不算撞限 —— 這是實際踩過的誤判', () => {
  // 一張「每分鐘輪詢四個外部 API 的 crawler」的卡，PM 在風險那節寫了
  // CoinGecko 的 rate limit。舊的做法掃全文，把它判成撞到訂閱額度，
  // 於是丟掉 $0.80 已經產出的 plan、回報一個不存在的原因。
  const r: AgentResult = {
    ...base,
    text: '### 風險\n\nCoinGecko 免費版有 rate limit，每分鐘輪詢要注意 quota 用量。',
    raw: '{"is_error":false,"result":"...rate limit...quota..."}',
  }
  assert.equal(isRateLimited(r), false)
})

test('QA 說「沒處理 rate limit」也不算撞限', () => {
  const r: AgentResult = {
    ...base,
    text: 'IMPLEMENTATION_BUG: 沒有處理 API 的 rate limit 與重試',
  }
  assert.equal(isRateLimited(r), false)
})

test('成功的呼叫一律不算撞限，不管內容寫什麼', () => {
  // ok === true 就代表 CLI 正常回覆了。撞限不可能長這樣。
  assert.equal(isRateLimited({ ...base, ok: true, text: 'usage limit reached' }), false)
})

test('HTTP 429 就是撞限', () => {
  assert.equal(isRateLimited({ ...base, ok: false, apiErrorStatus: 429 }), true)
})

test('CLI 自己回報的錯誤訊息才掃關鍵字', () => {
  const r: AgentResult = {
    ...base,
    ok: false,
    errors: ['Claude usage limit reached. Your limit will reset at 3pm.'],
  }
  assert.equal(isRateLimited(r), true)
})

test('失敗但不是限流 → 不算撞限', () => {
  // 這個要分得出來：真的撞限要停止整批排空，其他失敗只影響這張卡。
  const r: AgentResult = {
    ...base,
    ok: false,
    apiErrorStatus: 500,
    errors: ['internal server error'],
  }
  assert.equal(isRateLimited(r), false)
})

test('529 過載不算撞限 —— 那是重試的事，不是額度沒了', () => {
  assert.equal(isRateLimited({ ...base, ok: false, apiErrorStatus: 529 }), false)
})
