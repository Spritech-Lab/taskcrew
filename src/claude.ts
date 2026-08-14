import { run } from './shell.ts'

/**
 * 呼叫本機的 Claude Code CLI。
 *
 * taskcrew 從頭到尾不碰認證 —— 驅動的是使用者自己已經登入的 Claude Code，
 * 因此吃的是使用者自己的訂閱額度，不需要 API key、也不產生 API 帳單。
 */

/**
 * 無人看管時絕對不能做的事。
 *
 * 這是**機制層**的保護，不是 prompt 裡的請求 —— 就算 agent 判斷錯誤，
 * 這些工具呼叫也不會被執行。任何「請不要 push」之類的 prompt 都只是約定，
 * 約定會被忽略，機制不會。
 *
 * 對應設計文件 §10。
 */
export const DENIED_TOOLS = [
  // 不可逆 / 對外
  'Bash(git push*)',
  'Bash(gh pr create*)',
  'Bash(gh pr merge*)',
  'Bash(gh release*)',
  'Bash(npm publish*)',
  'Bash(pnpm publish*)',
  'Bash(yarn publish*)',
  // 不碰 main
  'Bash(git checkout main*)',
  'Bash(git checkout master*)',
  'Bash(git switch main*)',
  'Bash(git switch master*)',
  // 不動線上服務
  'Bash(pm2 stop*)',
  'Bash(pm2 delete*)',
  'Bash(pm2 restart*)',
  'Bash(launchctl*)',
  // 憑證
  'Bash(*.env*)',
  // 對外送出
  'WebFetch',
] as const

export type Role = 'pm' | 'junior' | 'senior' | 'qa'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AgentSpec {
  role: Role
  /** claude --model 的值（別名或完整名稱） */
  model: string
  /** claude --effort 的值 */
  effort: Effort
  /** 這個角色的系統提示，附加在預設系統提示之後 */
  systemPrompt: string
  /**
   * 這個角色**需要**哪些工具（正面表列，來自 agent 定義檔的 `tools:`）。
   * 未指定代表不額外限制。
   *
   * 注意這跟 DENIED_TOOLS 是不同層級：這裡是使用者可調的「需要什麼」，
   * DENIED_TOOLS 是寫死的「什麼都不准」。deny 永遠優先 ——
   * 編輯 agent 定義檔不該有可能意外授予 push 權限。
   */
  tools?: string[]
}

export interface AgentResult {
  ok: boolean
  /** agent 的最終文字輸出 */
  text: string
  /**
   * 這次用的 session。帶著它再呼叫一次就會續接同一段對話 ——
   * 常駐 agent 靠這個累積對某個 repo 的認識，不必每次從零摸索。
   */
  sessionId: string | null
  /** 這次呼叫的花費（USD 等值）；解析不到時為 null */
  costUsd: number | null
  /** claude 行程的 exit code */
  exitCode: number
  /** API 的 HTTP 狀態碼（429 = 限流）。正常結束時是 null */
  apiErrorStatus: number | null
  /** CLI 回報的錯誤訊息。只有 is_error 為真時才有內容 */
  errors: string[]
  raw: string
}

export interface InvokeOptions {
  /** agent 的工作目錄 —— 目標 repo，不是 board */
  cwd: string
  /**
   * 續接這個 session。
   *
   * 有它就是「同一個 agent 接著上次的認識繼續」，沒有就是全新的開始。
   * 換方案時刻意不帶 —— 那時要的正是不被上一個方案的思路錨定。
   */
  resume?: string | null
  /** 額外禁止的工具，附加在 DENIED_TOOLS 之後 */
  extraDenied?: readonly string[]
  timeoutMs?: number
}

export async function invoke(
  spec: AgentSpec,
  prompt: string,
  opts: InvokeOptions,
): Promise<AgentResult> {
  const denied = [...DENIED_TOOLS, ...(opts.extraDenied ?? [])]

  const args = [
    '-p',
    prompt,
    ...(opts.resume ? ['--resume', opts.resume] : []),
    '--model',
    spec.model,
    '--effort',
    spec.effort,
    '--append-system-prompt',
    spec.systemPrompt,
    '--output-format',
    'json',
    // 無人看管 —— 沒有人在旁邊按核准。安全性由 --disallowed-tools 保證，不由提示保證。
    '--permission-mode',
    'bypassPermissions',
    // deny 放在最後，語意上也在最後 —— 就算 agent 定義檔把某個工具列進
    // allowed，這裡的拒絕仍然生效。
    ...(spec.tools?.length ? ['--allowed-tools', ...spec.tools] : []),
    '--disallowed-tools',
    ...denied,
  ]

  const r = await run('claude', args, {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? 30 * 60_000,
  })

  if (r.code !== 0) {
    return {
      ok: false,
      text: '',
      sessionId: null,
      costUsd: null,
      exitCode: r.code,
      apiErrorStatus: null,
      errors: [r.stderr || r.stdout],
      raw: r.stderr || r.stdout,
    }
  }

  try {
    const parsed = JSON.parse(r.stdout) as {
      result?: string
      session_id?: string
      total_cost_usd?: number
      is_error?: boolean
      api_error_status?: number | null
      errors?: string[]
    }
    return {
      ok: parsed.is_error !== true,
      text: parsed.result ?? '',
      sessionId: parsed.session_id ?? null,
      costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
      exitCode: 0,
      apiErrorStatus: typeof parsed.api_error_status === 'number' ? parsed.api_error_status : null,
      errors: Array.isArray(parsed.errors) ? parsed.errors : [],
      raw: r.stdout,
    }
  } catch {
    return {
      ok: false,
      text: '',
      sessionId: null,
      costUsd: null,
      exitCode: 0,
      apiErrorStatus: null,
      errors: ['claude 的輸出不是合法 JSON'],
      raw: r.stdout,
    }
  }
}

/**
 * 撞到訂閱額度上限。
 *
 * 這是唯一的正常煞車（設計上不設花費上限、只吃訂閱額度），所以它是承重路徑：
 * 認出來之後必須把卡乾淨地退回「待執行」，分支留著，下次接得回去。
 */
export function isRateLimited(r: AgentResult): boolean {
  // **只看結構化欄位，不掃 agent 的回覆內容。**
  //
  // 原本是把 result 加 raw 全文小寫化之後找 'rate limit' / 'quota' 之類的字。
  // 那會誤判，而且誤判的方向最糟：**丟掉已經產出的成果，然後回報一個
  // 不存在的原因**。
  //
  // 實際踩到過：一張「每分鐘輪詢四個外部 API 的 crawler」的卡，PM 在風險那節
  // 寫了 API 的 rate limit，taskcrew 就判定撞到訂閱額度、把 $0.80 的 plan 丟掉。
  // 那次 `is_error` 是 false —— 結構上完全看得出來不是撞限。
  //
  // 卡片的主題越接近「呼叫外部服務」越容易誤判，而那是很常見的主題。
  if (r.ok) return false

  // 429 = Too Many Requests，這是唯一明確的限流狀態碼
  if (r.apiErrorStatus === 429) return true

  // CLI 自己回報的錯誤訊息才掃關鍵字 —— 那是它寫的，不是 agent 寫的
  const s = `${r.errors.join('\n')}\n${r.raw}`.toLowerCase()
  return (
    s.includes('rate limit') ||
    s.includes('usage limit') ||
    s.includes('too many requests')
  )
}
