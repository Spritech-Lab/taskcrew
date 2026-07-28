import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { createClient, type RedisClientType } from 'redis'
import type { Agents } from './agents.ts'
import type { AgentResult, Role } from './claude.ts'
import { format, type Dispatcher, type InvokeOpts, type PipelineEvent } from './dispatch.ts'

/**
 * Redis 匯流排。
 *
 * 這是「多 agent」真正成立的地方 —— agent 不再是被呼叫的子行程，
 * 而是常駐的訂閱者。三個用途：
 *
 *   1. 派工   coordinator → agent（LIST，剛好一個 agent 取到）
 *   2. 回覆   agent → coordinator（LIST，帶 requestId）
 *   3. 事件   coordinator → 任何訂閱者（PUB/SUB，入口層靠這個即時推回給你）
 *
 * 派工用 LIST 而不是 pub/sub，是因為 pub/sub 沒有持久性 ——
 * agent 剛好在重啟時發出的派工會直接消失。LIST 會等它回來。
 */

const NS = 'taskcrew'

/**
 * 依 board 隔離的鍵前綴。
 *
 * **這是 firewall 的一部分，不只是整潔問題。** 沒有它，任何 agent 行程都會
 * 消費任何 board 的派工 —— 你工作用的 agent 會撿走個人專案的工作，在錯的
 * repo 裡執行。實測時就發生過：背景跑著的 agent 把測試的派工搶去用真的模型執行。
 *
 * 用 board 絕對路徑的雜湊，不用 config 裡的名字 —— 兩個 board 可能同名，
 * 但路徑不會重複。
 */
export function boardNs(boardDir: string): string {
  return createHash('sha256').update(resolve(boardDir)).digest('hex').slice(0, 12)
}

export const KEYS = {
  request: (ns: string, role: Role) => `${NS}:${ns}:req:${role}`,
  response: (ns: string, id: string) => `${NS}:${ns}:res:${id}`,
  events: (ns: string) => `${NS}:${ns}:events`,
  /** 入口層下的指令。用 LIST 而非 pub/sub —— 服務重啟時的指令不該消失 */
  commands: (ns: string) => `${NS}:${ns}:commands`,
} as const

/**
 * 入口層可以下的指令。
 *
 * 卡進了 queue 只是排隊，**不會自己開始** —— 每次執行都是一次明確授權。
 * 這裡就是那個授權的形式：你在 Discord 講一句，入口層發一則 run 指令。
 */
export type Command =
  | { type: 'run'; at?: number }
  | { type: 'plan'; at?: number }

export async function sendCommand(boardDir: string, cmd: Command): Promise<void> {
  const client = await connect()
  try {
    await client.rPush(KEYS.commands(boardNs(boardDir)), JSON.stringify(cmd))
  } finally {
    await client.quit()
  }
}

export interface AgentRequest {
  id: string
  prompt: string
  cwd: string
  /**
   * 過了這個時間就不該再執行（epoch ms）。
   *
   * 派工佇列是持久的 —— 那是刻意的，agent 重啟時的派工不該消失。
   * 但持久性有個代價：coordinator 早就放棄的派工會留在佇列裡，
   * 等下次有 agent 起來時被憑空執行。實測時就發生過，白花了 $0.11。
   * 無人看管的情境下更糟：昨晚中斷的工作明天自己跑起來。
   */
  deadline: number
  /** 丟掉累積的 session，從零開始（換方案時用） */
  fresh?: boolean
}

export interface AgentResponse extends AgentResult {
  id: string
}

export function redisUrl(): string {
  return process.env.TASKCREW_REDIS_URL ?? 'redis://127.0.0.1:6379'
}

export async function connect(): Promise<RedisClientType> {
  const client: RedisClientType = createClient({ url: redisUrl() })
  client.on('error', () => {
    // 連線層的錯誤交給呼叫端的逾時處理 —— 這裡只是避免未處理的例外
    // 讓整個 runner 掛掉。agent 沒回應的後果已經有明確的處理路徑。
  })
  await client.connect()
  return client
}

/**
 * 走匯流排派工。agent 是常駐的訂閱者，用自己的定義檔決定 model 與 effort，
 * 所以這裡只送「要做什麼」和「在哪做」。
 */
export class BusDispatcher implements Dispatcher {
  readonly #client: RedisClientType
  readonly #ns: string
  readonly #agents: Agents
  readonly #log: (line: string) => void
  /** 等 agent 回覆的上限（秒）。逾時會被當成 agent 失聯 */
  readonly #timeoutSec: number

  constructor(
    client: RedisClientType,
    boardDir: string,
    agents: Agents,
    log: (line: string) => void,
    timeoutSec = 30 * 60,
  ) {
    this.#client = client
    this.#ns = boardNs(boardDir)
    this.#agents = agents
    this.#log = log
    this.#timeoutSec = timeoutSec
  }

  describe(role: Role) {
    const a = this.#agents[role]
    return { model: a.model, effort: a.effort }
  }

  static async create(
    boardDir: string,
    agents: Agents,
    log: (line: string) => void,
    timeoutSec?: number,
  ): Promise<BusDispatcher> {
    return new BusDispatcher(await connect(), boardDir, agents, log, timeoutSec)
  }

  async invoke(role: Role, prompt: string, cwd: string, opts?: InvokeOpts): Promise<AgentResult> {
    const id = randomUUID()
    const req: AgentRequest = {
      id,
      prompt,
      cwd,
      deadline: Date.now() + this.#timeoutSec * 1000,
      fresh: opts?.fresh,
    }
    await this.#client.rPush(KEYS.request(this.#ns, role), JSON.stringify(req))

    // 每個請求一條專屬的回覆佇列 —— 不會跟其他請求的回覆混在一起
    const raw = await this.#client.blPop(KEYS.response(this.#ns, id), this.#timeoutSec)
    if (!raw) {
      return {
        ok: false,
        text: '',
        sessionId: null,
        costUsd: null,
        exitCode: -1,
        raw: `等 ${role} agent 回覆逾時（${this.#timeoutSec}s）—— 它可能沒在跑，或中途死了`,
      }
    }
    const res = JSON.parse(raw.element) as AgentResponse
    return {
      ok: res.ok,
      text: res.text,
      sessionId: res.sessionId,
      costUsd: res.costUsd,
      exitCode: res.exitCode,
      raw: res.raw,
    }
  }

  emit(event: PipelineEvent): void {
    // 事件是 fire-and-forget：推播失敗不該讓產線停下來
    void this.#client.publish(KEYS.events(this.#ns), JSON.stringify(event)).catch(() => {})
    const line = format(event)
    if (line) this.#log(line)
  }

  async close(): Promise<void> {
    await this.#client.quit()
  }
}

/** 檢查 Redis 在不在。啟動時先確認，比派工到一半才發現好。 */
export async function pingBus(): Promise<boolean> {
  try {
    const c = await connect()
    await c.ping()
    await c.quit()
    return true
  } catch {
    return false
  }
}
