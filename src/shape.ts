import type { TestResult } from './types.ts'

/**
 * 失敗形狀 —— 分辨「實作沒寫對」和「方案本身不對」。
 *
 * 這是整套失敗處理的核心判準，而且刻意**完全機械**：只看測試逐條結果跨輪的變化，
 * 不問任何 agent 的意見。理由很簡單 —— 判錯的代價是整條路線走歪，
 * 而「這是實作問題還是設計問題」正是最不該用感覺回答的問題。
 *
 * 對應設計文件 §9.1。
 */
export type Shape =
  /** 失敗數逐輪減少 —— 實作在收斂，繼續修 */
  | 'converging'
  /** 每輪失敗的是同一批，數量沒動 —— 這個方案碰不到那批條件 */
  | 'stuck'
  /** 修好一批、弄壞另一批 —— 方案的結構有問題 */
  | 'oscillating'
  /** 從第一輪就幾乎全掛 —— 方案根本走錯方向 */
  | 'all-failing'
  /** 全過 */
  | 'passing'
  /** 資訊不足（沒有逐條結果，或只有一輪且沒有明顯訊號） */
  | 'unknown'

/** 判定形狀時，「幾乎全掛」的門檻 */
const ALL_FAILING_RATIO = 0.8

export function analyze(rounds: readonly (TestResult[] | null)[]): Shape {
  const known = rounds.filter((r): r is TestResult[] => r !== null && r.length > 0)
  if (known.length === 0) return 'unknown'

  const latest = known[known.length - 1]
  if (latest.every((t) => t.passed)) return 'passing'

  // 第一輪就幾乎全掛 —— 不用等第二輪，方向就錯了
  const first = known[0]
  const firstFailRatio = first.filter((t) => !t.passed).length / first.length
  if (known.length === 1) {
    return firstFailRatio >= ALL_FAILING_RATIO ? 'all-failing' : 'unknown'
  }

  const prev = known[known.length - 2]
  const prevFailed = failedNames(prev)
  const nowFailed = failedNames(latest)

  // 震盪：上一輪過的，這一輪掛了。東牆補西牆，方案結構有問題。
  const regressed = [...nowFailed].some((n) => !prevFailed.has(n))
  if (regressed) return 'oscillating'

  if (nowFailed.size < prevFailed.size) return 'converging'

  // 失敗集合完全沒動 —— 卡住了
  if (sameSet(prevFailed, nowFailed)) return 'stuck'

  return 'unknown'
}

/** 這個形狀該不該從內層升到中層（換方案）。 */
export function shouldEscalate(shape: Shape): boolean {
  return shape === 'stuck' || shape === 'oscillating' || shape === 'all-failing'
}

export function describe(shape: Shape): string {
  switch (shape) {
    case 'passing':
      return '全部通過'
    case 'converging':
      return '失敗數逐輪減少，實作在收斂'
    case 'stuck':
      return '每輪失敗的是同一批測試，數量沒動 —— 這個方案碰不到那批條件'
    case 'oscillating':
      return '修好一批又弄壞另一批 —— 方案的結構有問題'
    case 'all-failing':
      return '從第一輪就幾乎全掛 —— 方案走錯方向'
    case 'unknown':
      return '資訊不足以判定形狀'
  }
}

function failedNames(rs: readonly TestResult[]): Set<string> {
  return new Set(rs.filter((t) => !t.passed).map((t) => t.name))
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x))
}
