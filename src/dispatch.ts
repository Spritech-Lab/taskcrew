import type { Agents } from './agents.ts'
import { invoke, type AgentResult, type Role } from './claude.ts'

/**
 * agent 要怎麼被叫起來。
 *
 * 這個介面是「單線」與「訊息驅動」的分界 —— coordinator 的狀態機
 * （升級判斷、修正／換方案的決策）完全不知道 agent 是子行程還是常駐訂閱者。
 *
 * 兩種實作：
 *   Local —— 直接 spawn `claude -p`，零基礎設施。**這是預設**，
 *            因為別人 `npm install` 想試一下不該先被要求架一個服務
 *   Bus   —— 走 Redis，agent 是常駐的訂閱者（見 bus.ts）
 */
export interface InvokeOpts {
  /**
   * 丟掉這個角色在這個 repo 累積的 session，從零開始。
   *
   * 只有換方案時該用 —— 那時要的正是不被上一個方案的思路錨定。
   * 其餘情況都該續接，讓 agent 保住對這個 repo 的認識。
   */
  fresh?: boolean
}

export interface Dispatcher {
  invoke(role: Role, prompt: string, cwd: string, opts?: InvokeOpts): Promise<AgentResult>
  /**
   * 這個角色的模型設定，只給事件顯示用。
   *
   * 走匯流排時這是**本地讀到的定義**，遠端 agent 可能跑著舊版 ——
   * 那種不一致本來就該被看見，不該被藏起來。
   */
  describe(role: Role): { model: string; effort: string }
  /** 產線的事件。Local 只印到終端機，Bus 會發到匯流排讓入口層訂閱 */
  emit(event: PipelineEvent): void
  close(): Promise<void>
}

/**
 * 產線事件。
 *
 * 刻意是結構化資料而非人看的字串 —— 訂閱端（Discord、TG）要能自己決定
 * 怎麼呈現、要不要過濾、哪些值得推播。字串做不到這些。
 * 終端機那端把事件格式化回中文，可讀性不損失。
 */
export type PipelineEvent =
  | { type: 'card-start'; card: string; title: string }
  | { type: 'attempt-start'; card: string; attempt: number; branch: string }
  | { type: 'round-start'; card: string; attempt: number; version: number; round: number; role: Role; model: string; effort: string }
  | { type: 'verify'; card: string; attempt: number; version: number; round: number; summary: string; passed: boolean; afterReduction?: boolean }
  | { type: 'reduce-start'; card: string; attempt: number; version: number; round: number }
  | { type: 'qa-start'; card: string; attempt: number; version: number; round: number }
  | { type: 'qa-reject'; card: string; attempt: number; version: number; round: number; detail: string }
  | { type: 'stay-inner'; card: string; attempt: number; version: number; round: number; shape: string }
  | { type: 'plan-revised'; card: string; attempt: number; version: number }
  | { type: 'plan-replaced'; card: string; attempt: number }
  | { type: 'revisions-exhausted'; card: string; attempt: number; max: number }
  | { type: 'card-done'; card: string; attempts: number; costUsd: number }
  | { type: 'card-failed'; card: string; reason: string }
  | { type: 'card-proposed'; card: string }
  | { type: 'card-blocked'; card: string; waitingOn: string[] }
  | { type: 'card-rejected'; card: string; problems: string[] }
  | { type: 'rate-limited'; card: string }
  | { type: 'queue-empty' }
  | { type: 'queue-start'; count: number }

export class LocalDispatcher implements Dispatcher {
  readonly #agents: Agents
  readonly #log: (line: string) => void
  /**
   * 每個 (角色, repo) 的 session。
   *
   * 本機模式沒有常駐行程，但**一次排空就是一個行程** ——
   * 所以同一次執行裡的第二張卡，PM 已經認識這個 repo 了。
   * 換 repo 就換 session：不同專案的脈絡不該混在一起。
   */
  readonly #sessions = new Map<string, string>()

  constructor(agents: Agents, log: (line: string) => void) {
    this.#agents = agents
    this.#log = log
  }

  async invoke(role: Role, prompt: string, cwd: string, opts?: InvokeOpts): Promise<AgentResult> {
    const key = `${role}:${cwd}`
    if (opts?.fresh) this.#sessions.delete(key)
    const r = await invoke(this.#agents[role], prompt, { cwd, resume: this.#sessions.get(key) })
    if (r.sessionId) this.#sessions.set(key, r.sessionId)
    return r
  }

  describe(role: Role) {
    const a = this.#agents[role]
    return { model: a.model, effort: a.effort }
  }

  emit(event: PipelineEvent): void {
    const line = format(event)
    if (line) this.#log(line)
  }

  async close(): Promise<void> {}
}

/** 事件 → 終端機的中文字串。訂閱端不會用這個，它們拿到的是事件本身。 */
export function format(e: PipelineEvent): string | null {
  switch (e.type) {
    case 'queue-start':
      return `「待執行」有 ${e.count} 張卡。`
    case 'queue-empty':
      return '「待執行」沒有卡，收工。'
    case 'card-start':
      return `▸  ${e.card} ${e.title}`
    case 'attempt-start':
      return `   [方案 ${e.attempt}] 分支 ${e.branch}`
    case 'round-start':
      return `   [${tag(e)}] ${e.role} 開發（${e.model} / ${e.effort}）`
    case 'reduce-start':
      return `   [${tag(e)}] senior 減法 review`
    case 'verify':
      return `   [${tag(e)}] ${e.afterReduction ? '減法後驗收' : '驗收'} ${e.summary}`
    case 'qa-start':
      return `   [${tag(e)}] QA 判定`
    case 'qa-reject':
      return `   [${tag(e)}] QA 退回：${e.detail}`
    case 'stay-inner':
      return `   [${tag(e)}] ${e.shape} → 留內層`
    case 'plan-revised':
      return `   [方案 ${e.attempt}] PM 修正 plan（v${e.version}）→ 同一條分支接著做`
    case 'plan-replaced':
      return `   [方案 ${e.attempt}] → 換方案`
    case 'revisions-exhausted':
      return `   [方案 ${e.attempt}] 修正 ${e.max} 次仍未通過 → 改為換方案`
    case 'card-done':
      return `   ✓ 通過（${e.attempts} 個方案，$${e.costUsd.toFixed(2)}）`
    case 'card-failed':
      return `   ✗ ${e.reason}`
    case 'card-proposed':
      return '   ↩ PM 提出新方案，退回「設計待批准」等你批准'
    case 'card-blocked':
      return `⏸  ${e.card} —— 等 ${e.waitingOn.join('、')}`
    case 'card-rejected':
      return `✗  ${e.card} —— 沒過閘門：\n${e.problems.map((p) => `     · ${p}`).join('\n')}`
    case 'rate-limited':
      return '⏹  撞到訂閱額度上限，停止排空。卡已退回「待執行」，分支留著。'
  }
}

function tag(e: { attempt: number; version: number; round: number }): string {
  const a = e.version === 1 ? `方案 ${e.attempt}` : `方案 ${e.attempt}·v${e.version}`
  return `${a}·輪 ${e.round}`
}
