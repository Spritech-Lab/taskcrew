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

// 腳本放在**目標 repo 裡**，不是全域環境變數 —— 一個測試可能同時開兩個
// fixture（例如驗證兩個 board 的隔離），全域狀態會讓它們互相蓋掉。
// cwd 是 invoke() 設定的目標 repo，所以每個 fixture 自然有自己的腳本。
const scriptPath = resolve(process.cwd(), '.tc-fake.json')
let steps
try {
  steps = JSON.parse(readFileSync(scriptPath, 'utf8'))
} catch {
  console.error(`fake-claude: 在 ${process.cwd()} 找不到 .tc-fake.json`)
  process.exit(2)
}

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
const logPath = join(process.cwd(), '.tc-fake-calls.jsonl')
{
  const modelIdx = process.argv.indexOf('--model')
  const effortIdx = process.argv.indexOf('--effort')
  const resumeIdx = process.argv.indexOf('--resume')
  appendFileSync(
    logPath,
    JSON.stringify({
      step: i,
      model: modelIdx > 0 ? process.argv[modelIdx + 1] : null,
      effort: effortIdx > 0 ? process.argv[effortIdx + 1] : null,
      // 測試靠這個確認「換方案時重置、其餘延續」有沒有做對
      resume: resumeIdx > 0 ? process.argv[resumeIdx + 1] : null,
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

// session_id 依 (模型, 工作目錄) 決定 —— 模擬「同一個 agent 在同一個 repo
// 續接同一段對話」。續接時回傳同一個 id，就像真的 claude 一樣。
const modelIdx2 = process.argv.indexOf('--model')
const model = modelIdx2 > 0 ? process.argv[modelIdx2 + 1] : 'x'
console.log(
  JSON.stringify({
    result: step.text ?? '',
    session_id: `sess-${model}-${Buffer.from(process.cwd()).toString('base64url').slice(-6)}`,
    total_cost_usd: step.cost ?? 0,
    is_error: step.isError ?? false,
  }),
)
