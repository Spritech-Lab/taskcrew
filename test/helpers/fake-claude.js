#!/usr/bin/env node
/**
 * 假的 `claude` CLI，給整合測試用。
 *
 * 為什麼需要它：中層循環、內層第二輪、autonomy 分支這些**控制流**，用真 agent
 * 測既貴又不可重現 —— agent 每次行為不一樣，測不出「stuck 有沒有正確升級」。
 * 控制流要用確定性的方式釘死；真 agent 留給品質驗證。
 *
 * 用法：把這個檔案所在目錄放進 PATH 前面，並設定 TC_FAKE_SCRIPT 指向一份 JSON：
 *
 *   [
 *     { "text": "做完了", "cost": 0.01, "apply": { "src/x.js": "新內容" } },
 *     { "text": "IMPLEMENTATION_BUG: 少了一條" }
 *   ]
 *
 * 每被呼叫一次就消費一步。`apply` 讓假 agent 能真的改檔案 ——
 * 沒有這個，跨輪的測試結果不會變，也就測不出失敗形狀。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const scriptPath = process.env.TC_FAKE_SCRIPT
if (!scriptPath) {
  console.error('fake-claude: 未設定 TC_FAKE_SCRIPT')
  process.exit(2)
}

const steps = JSON.parse(readFileSync(scriptPath, 'utf8'))
const cursorPath = `${scriptPath}.cursor`

let i = 0
try {
  i = Number(readFileSync(cursorPath, 'utf8')) || 0
} catch {
  i = 0
}

if (i >= steps.length) {
  console.error(`fake-claude: 腳本用完了（第 ${i + 1} 次呼叫，只有 ${steps.length} 步）`)
  process.exit(3)
}

const step = steps[i]
writeFileSync(cursorPath, String(i + 1), 'utf8')

// 記錄這次呼叫用了哪個模型 —— 測試用它確認角色路由正確
// （例如「第二輪真的換成 senior 了嗎」）
const logPath = process.env.TC_FAKE_LOG
if (logPath) {
  const modelIdx = process.argv.indexOf('--model')
  const effortIdx = process.argv.indexOf('--effort')
  appendFileSync(
    logPath,
    JSON.stringify({
      step: i,
      model: modelIdx > 0 ? process.argv[modelIdx + 1] : null,
      effort: effortIdx > 0 ? process.argv[effortIdx + 1] : null,
    }) + '\n',
    'utf8',
  )
}

// 模擬 agent 改檔案。cwd 是目標 repo（invoke 會設）。
for (const [rel, content] of Object.entries(step.apply ?? {})) {
  const p = resolve(process.cwd(), rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content, 'utf8')
}

if (step.exit) process.exit(step.exit)

console.log(
  JSON.stringify({
    result: step.text ?? '',
    total_cost_usd: step.cost ?? 0,
    is_error: step.isError ?? false,
  }),
)
