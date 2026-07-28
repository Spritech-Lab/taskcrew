/** 看板的九個狀態。定義在 board 的 backlog/config.yml，這裡是 taskcrew 認得的那組。 */
export const STATUS = {
  開卡: '開卡',
  需求討論: '需求討論',
  規劃中: '規劃中',
  設計待批准: '設計待批准',
  阻塞: '阻塞',
  待執行: '待執行',
  執行中: '執行中',
  執行完成回報: '執行完成回報',
  完成: '完成',
} as const

export type Status = (typeof STATUS)[keyof typeof STATUS]

/**
 * 失敗時的自主程度。
 * none    — 停，標 failed
 * propose — PM 產新 plan 寫回卡上，退回「設計待批准」，不執行
 * replan:N — 自己換方案並執行，最多 N 次
 * free    — 換到成功或撞額度
 */
export type Autonomy =
  | { kind: 'none' }
  | { kind: 'propose' }
  | { kind: 'replan'; max: number }
  | { kind: 'free' }

export function parseAutonomy(raw: unknown): Autonomy | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (s === 'none') return { kind: 'none' }
  if (s === 'propose') return { kind: 'propose' }
  if (s === 'free') return { kind: 'free' }
  const m = /^replan:(\d+)$/.exec(s)
  if (m) return { kind: 'replan', max: Number(m[1]) }
  return null
}

/** `## Runner Config` 區塊裡的 YAML。這些欄位不能放 frontmatter — Backlog.md 會刪掉不認識的鍵。 */
export interface RunnerConfig {
  /** 目標 repo 的路徑，可用 ~ 開頭 */
  project: string
  /** 分支從哪裡長出來 */
  base_branch: string
  /** 驗收指令。必須產出逐條結果，不能只有 exit code */
  verify: string
  autonomy: Autonomy
  /**
   * 下游要等你親自驗過才准開始。預設 false。
   *
   * 預設之所以是「不等」：卡跑到「執行完成回報」代表測試逐條過了、QA 也過了，
   * 介面是真的、能被下游 import。這時停下來等人，換到的是一個「可能發生、
   * 代價有界（一張卡的 token，分支還留著）」的保險，付出的是「必然發生、
   * 代價是整晚產能」的損失 —— 一條四張卡的依賴鏈會需要你醒來四次。
   *
   * 標成 true 的時機：這張卡是別人的地基，而且錯了下游全廢。
   */
  require_review: boolean
}

export interface Card {
  id: string
  title: string
  status: string
  labels: string[]
  dependencies: string[]
  parentTaskId?: string
  /** 卡片檔案的絕對路徑 */
  path: string
  /** frontmatter 全部欄位，含 taskcrew 不認識的 — 寫回時原樣保留 */
  frontmatter: Record<string, unknown>
  /** `## 標題` → 該區塊的內容（不含標題行） */
  sections: Record<string, string>
  /** 解析過的 Runner Config；區塊缺失或格式錯誤時為 null */
  runner: RunnerConfig | null
}

/** verify 指令的逐條結果。跨輪比較它就得到失敗形狀。 */
export interface TestResult {
  name: string
  passed: boolean
}

export interface VerifyOutcome {
  /** 指令的 exit code */
  exitCode: number
  /** 解析出的逐條結果；解析失敗時為 null，此時只有 exitCode 可用 */
  results: TestResult[] | null
  stdout: string
  stderr: string
}
