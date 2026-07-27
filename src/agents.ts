import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import type { AgentSpec, Effort, Role } from './claude.ts'

/**
 * agent 定義的載入。
 *
 * 用 Claude Code 原生的 agent 檔案格式（`model` / `effort` / `tools` frontmatter
 * ＋ markdown 本文當系統提示），不自己發明一套 —— 同一份定義在互動式
 * Claude Code 裡也能用，而且使用者不需要為了調模型去改 taskcrew 的原始碼。
 *
 * 解析順序：`<board>/agents/<role>.md` → 套件內建的預設。
 * 放在 board repo 而不是套件裡，是為了讓 agent 編制跟看板一起版本控制 ——
 * 兩個身份的 board 可以有各自不同的模型配置。
 */

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 檔名 ↔ 角色 */
export const ROLE_FILES: Record<Role, string> = {
  pm: 'pm.md',
  junior: 'junior-rd.md',
  senior: 'senior-rd.md',
  qa: 'qa.md',
}

export interface Agents {
  pm: AgentSpec
  junior: AgentSpec
  senior: AgentSpec
  qa: AgentSpec
}

/**
 * 所有角色共用的守則。
 *
 * **刻意留在程式碼裡，不放進 agent 定義檔。** 這裡的每一條都是協定或安全相關：
 * 停手的訊號格式、不准 commit/push、範圍限制。使用者編輯 agent 檔案時
 * 不該有可能把這些刪掉 —— 那跟 `--disallowed-tools` 是同一個道理，
 * 安全邊界是機制，不是設定。
 */
const COMMON = `
你在 taskcrew 的無人看管產線上工作。沒有人在旁邊看，你問不到問題。

規則：
- 只做本次任務明確範圍內的事。不順手重構、不加沒被要求的功能、不動無關的檔案。
- 你已經在正確的分支上（外層已切好）。不要切換分支、不要 commit、不要 push。
- 規格不清楚，或需要替使用者做設計抉擇 → 停。回覆的第一行寫 \`BLOCKED: <你需要什麼決定>\`，然後什麼都不要改。
- 用繁體中文回報，一兩句話說明你做了什麼，不要長篇、不要貼整段 diff。
`.trim()

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

export async function loadAgents(boardDir: string): Promise<Agents> {
  const [pm, junior, senior, qa] = await Promise.all([
    loadRole('pm', boardDir),
    loadRole('junior', boardDir),
    loadRole('senior', boardDir),
    loadRole('qa', boardDir),
  ])
  return { pm, junior, senior, qa }
}

async function loadRole(role: Role, boardDir: string): Promise<AgentSpec> {
  const file = ROLE_FILES[role]
  const raw =
    (await readIfExists(join(boardDir, 'agents', file))) ??
    (await readIfExists(join(PACKAGE_ROOT, 'agents', file)))

  if (raw === null) {
    throw new Error(`找不到 ${role} 的 agent 定義（${file}）—— 套件安裝可能不完整`)
  }
  return parseAgent(role, raw, file)
}

export function parseAgent(role: Role, raw: string, source: string): AgentSpec {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!m) throw new Error(`${source} 缺少 frontmatter`)

  let fm: Record<string, unknown>
  try {
    fm = (parseYaml(m[1]) ?? {}) as Record<string, unknown>
  } catch (e) {
    throw new Error(`${source} 的 frontmatter 不是合法的 YAML：${e}`)
  }

  const model = fm.model
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error(`${source} 缺少 model（例如 opus / sonnet / haiku）`)
  }

  const effort = fm.effort ?? 'high'
  if (typeof effort !== 'string' || !EFFORTS.has(effort)) {
    throw new Error(`${source} 的 effort 必須是 ${[...EFFORTS].join(' / ')}，收到：${String(effort)}`)
  }

  const body = m[2].trim()
  if (!body) throw new Error(`${source} 沒有系統提示內容`)

  return {
    role,
    model: model.trim(),
    effort: effort as Effort,
    // 共用守則永遠在前面，agent 檔只負責角色特有的部分
    systemPrompt: `${COMMON}\n\n${body}`,
    tools: parseTools(fm.tools),
  }
}

/** `tools: Read, Glob, Grep` 或 YAML 陣列都接受。未指定代表不限制。 */
function parseTools(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String).filter(Boolean)
  if (typeof v === 'string' && v.trim()) {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return undefined
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8')
  } catch {
    return null
  }
}

/** 把套件內建的預設複製到 board —— `taskcrew init` 用 */
export async function defaultAgentFiles(): Promise<{ name: string; content: string }[]> {
  const out: { name: string; content: string }[] = []
  for (const file of Object.values(ROLE_FILES)) {
    const content = await readFile(join(PACKAGE_ROOT, 'agents', file), 'utf8')
    out.push({ name: file, content })
  }
  return out
}
