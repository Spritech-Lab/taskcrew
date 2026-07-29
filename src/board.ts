import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { parseAutonomy, type Card, type RunnerConfig } from './types.ts'

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/**
 * 讀寫 Backlog.md 的卡片檔案。
 *
 * 刻意不透過 `backlog` CLI：
 *  - CLI 沒有 JSON 輸出
 *  - `backlog task view --plain` 不顯示它不認識的區塊（看不到 Runner Config）
 * 檔案才是真實來源，CLI 是給人看的有損視圖。
 *
 * 寫回一律用外科手術式的字串替換，不重新生成整個檔案 —— Backlog.md 會刪掉
 * frontmatter 裡它不認識的鍵，我們不能犯同樣的錯。
 */

export function tasksDir(boardDir: string): string {
  return join(boardDir, 'backlog', 'tasks')
}

export async function listCards(boardDir: string): Promise<Card[]> {
  const dir = tasksDir(boardDir)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    throw new Error(`找不到看板：${dir}（這個目錄是 backlog init 建出來的嗎？）`)
  }
  const cards: Card[] = []
  for (const name of names.filter((n) => n.endsWith('.md'))) {
    cards.push(await readCard(join(dir, name)))
  }
  return cards
}

export async function readCard(path: string): Promise<Card> {
  const raw = await readFile(path, 'utf8')
  const fm = FRONTMATTER.exec(raw)
  if (!fm) throw new Error(`卡片沒有 frontmatter：${path}`)

  const frontmatter = (parseYaml(fm[1]) ?? {}) as Record<string, unknown>
  const body = raw.slice(fm[0].length)
  const sections = splitSections(body)

  return {
    id: String(frontmatter.id ?? ''),
    title: String(frontmatter.title ?? ''),
    status: String(frontmatter.status ?? ''),
    labels: asStringArray(frontmatter.labels),
    dependencies: asStringArray(frontmatter.dependencies),
    parentTaskId: frontmatter.parent_task_id
      ? String(frontmatter.parent_task_id)
      : undefined,
    ordinal: typeof frontmatter.ordinal === 'number' ? frontmatter.ordinal : undefined,
    path,
    frontmatter,
    sections,
    runner: parseRunnerConfig(sections['Runner Config']),
  }
}

/**
 * 這些 `## 標題` 才算區塊邊界，其餘一律當內容。
 *
 * 不能單純看「行首的 `##`」—— 區塊內文本來就會有子標題（PM 產出的 plan 就用了
 * `## 現況`、`## 做法`）。只認已知名稱，內文想怎麼下標題都不會把區塊切斷。
 */
const KNOWN_SECTIONS = [
  'Runner Config',
  'Description',
  'Acceptance Criteria',
  'Implementation Plan',
  'Implementation Notes',
  'Excluded Approaches',
  'Definition of Done',
] as const

const KNOWN = new Set<string>(KNOWN_SECTIONS)

/** 以已知的 `## 區塊名` 切開內文。值保留原始內容，含 Backlog.md 的 HTML 標記。 */
function splitSections(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  const lines = body.split('\n')
  let heading: string | null = null
  let buf: string[] = []

  const flush = () => {
    if (heading !== null) out[heading] = buf.join('\n').trim()
  }

  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line)
    if (m && KNOWN.has(m[1])) {
      flush()
      heading = m[1]
      buf = []
    } else if (heading !== null) {
      buf.push(line)
    }
  }
  flush()
  return out
}

/**
 * 把內容裡的 `## 子標題` 降一級成 `### `。
 *
 * agent 產出的 markdown 常用 `##` 當自己的最上層標題，塞進區塊之後層級就亂了
 * （區塊標題本身也是 `##`）。降級是機制，比在提示裡拜託它「請用 ###」可靠。
 * 跳過 code fence 裡的內容 —— 那裡的 `#` 是 shell 註解或別的語言，不是標題。
 */
function demoteHeadings(content: string): string {
  let inFence = false
  return content
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      return /^##\s+/.test(line) ? `#${line}` : line
    })
    .join('\n')
}

const RUNNER_BLOCK = /<!--\s*RUNNER:BEGIN\s*-->([\s\S]*?)<!--\s*RUNNER:END\s*-->/
const YAML_FENCE = /```(?:ya?ml)?\r?\n([\s\S]*?)```/

function parseRunnerConfig(section: string | undefined): RunnerConfig | null {
  if (!section) return null
  const block = RUNNER_BLOCK.exec(section)
  if (!block) return null
  const fence = YAML_FENCE.exec(block[1])
  if (!fence) return null

  let doc: Record<string, unknown>
  try {
    doc = (parseYaml(fence[1]) ?? {}) as Record<string, unknown>
  } catch {
    return null
  }

  const autonomy = parseAutonomy(doc.autonomy)
  const project = doc.project
  const baseBranch = doc.base_branch
  const verify = doc.verify

  // 缺任一必填欄位就整份判定為無效 —— 閘門會擋下來並說明缺什麼，
  // 這裡回傳半殘的設定只會讓錯誤更晚才炸。
  if (
    typeof project !== 'string' ||
    typeof baseBranch !== 'string' ||
    typeof verify !== 'string' ||
    !autonomy
  ) {
    return null
  }

  return {
    project,
    base_branch: baseBranch,
    verify,
    autonomy,
    // 選填，預設 false。少數卡才需要，不該逼每張卡都寫。
    require_review: doc.require_review === true,
  }
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string' && v.trim()) return [v]
  return []
}

/** 只換 frontmatter 的 status 那一行，並更新 updated_date。其餘一字不動。 */
export async function setStatus(card: Card, status: string): Promise<void> {
  const raw = await readFile(card.path, 'utf8')
  const fm = FRONTMATTER.exec(raw)
  if (!fm) throw new Error(`卡片沒有 frontmatter：${card.path}`)

  let head = fm[1]
  head = replaceScalarLine(head, 'status', status)
  head = replaceScalarLine(head, 'updated_date', `'${timestamp()}'`)

  await writeFile(card.path, `---\n${head}\n---\n${raw.slice(fm[0].length)}`, 'utf8')
  card.status = status
}

/** 換掉 `key: ...` 那一行；key 不存在就附加在最後。 */
function replaceScalarLine(head: string, key: string, value: string): string {
  const re = new RegExp(`^${key}:.*$`, 'm')
  return re.test(head) ? head.replace(re, `${key}: ${value}`) : `${head}\n${key}: ${value}`
}

function timestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 覆寫（或新增）一個內文區塊。
 * 區塊不存在時附加到檔案結尾；存在時只換該區塊，相鄰區塊不受影響。
 */
export async function upsertSection(
  card: Card,
  heading: string,
  content: string,
): Promise<void> {
  const raw = await readFile(card.path, 'utf8')
  const block = `## ${heading}\n\n${demoteHeadings(content.trim())}\n`

  // 逐行找邊界，不用正規表示式。
  //
  // 原本寫成 `(?=^##\\s|\\z)`，但 **JavaScript 沒有 `\z`** —— 它是字母 `z` 的
  // identity escape，不是字串結尾。於是「要換的區塊在檔案最後、內容裡剛好
  // 沒有 z」時比對不到，變成附加而不是取代，卡片上就出現兩個同名區塊。
  // 而 Implementation Plan 和 Implementation Notes 正好都是最後一個區塊。
  const lines = raw.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`).test(l))

  let next: string
  if (start < 0) {
    next = `${raw.replace(/\s*$/, '')}\n\n${block}`
  } else {
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) { end = i; break }
    }
    next = [...lines.slice(0, start), block, ...lines.slice(end)].join('\n')
  }

  await writeFile(card.path, next, 'utf8')
  card.sections[heading] = content.trim()
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 去掉 agent 輸出開頭自己加的標題。
 *
 * 就算提示裡寫了「直接輸出內容、不要加前言」，模型仍常常回一個
 * `# Implementation Plan：…` 開頭 —— 而區塊標題是我們寫的，兩個疊起來就重複了。
 * 與其反覆調提示（那是約定），不如在寫入前處理掉（那是機制）。
 */
export function stripLeadingHeading(text: string, sectionName: string): string {
  let s = text.trim()
  const needle = normalize(sectionName)

  // 只剝「標題內容就是區塊名」的那幾行 —— agent 常疊寫成
  // `## Implementation Plan` + `# Implementation Plan：xxx`。
  // 其餘標題（`## 現況` 之類）是真內容，不能碰。
  while (true) {
    const m = /^#{1,6}\s+(.*?)\s*(?:\r?\n|$)/.exec(s)
    if (!m || !normalize(m[1]).startsWith(needle)) break
    s = s.slice(m[0].length).trim()
  }
  return s
}

/** 比對用：去掉大小寫、空白與各種標點的差異 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s:：\-—_.。、,，]/g, '')
}

/**
 * 看板上的順序。**跟你在 web UI 上看到的順序一致。**
 *
 * Backlog.md 用 `ordinal` 表示欄位內的位置，你拖動卡片就是在改它。
 * 不照它排的話，你在 UI 上調的順序會被默默忽略 —— 那是最糟的一種行為：
 * 介面讓你以為你控制得了，實際上沒有。
 *
 * 沒有 `ordinal` 的卡排在最後（手寫的卡可能沒這個欄位），同順位再比 ID。
 *
 * 刻意**不把 Backlog.md 的 milestone 加進排序**：看板一欄就是一個扁平清單，
 * 執行順序要跟你看到的一樣。要讓某些卡先跑，就在 UI 上把它們拖到前面。
 */
export function byBoardOrder(a: Card, b: Card): number {
  const oa = a.ordinal ?? Number.POSITIVE_INFINITY
  const ob = b.ordinal ?? Number.POSITIVE_INFINITY
  if (oa !== ob) return oa - ob
  return a.id.localeCompare(b.id, undefined, { numeric: true })
}
