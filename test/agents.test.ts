import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadAgents, parseAgent } from '../src/agents.ts'

/**
 * agent 定義的載入。
 *
 * 重點在**覆寫**這條路徑：使用者要能改 model 和 effort 而不必碰 taskcrew 的
 * 原始碼，否則「model 跟 thinking mode 由你設計」這句話就不成立。
 */

async function boardWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tc-ag-'))
  await mkdir(join(dir, 'agents'), { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, 'agents', name), content, 'utf8')
  }
  return dir
}

test('沒有 board 層定義時，用套件內建的預設', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-ag-'))
  const a = await loadAgents(dir)
  assert.equal(a.pm.model, 'opus')
  assert.equal(a.junior.model, 'sonnet')
  assert.equal(a.senior.model, 'opus')
  assert.equal(a.qa.model, 'haiku')
})

test('board 層的定義會覆寫預設 —— 這是「你自己調」的實際機制', async () => {
  const dir = await boardWith({
    'qa.md': '---\nname: qa\nmodel: sonnet\neffort: max\n---\n你是 QA。',
  })
  const a = await loadAgents(dir)
  assert.equal(a.qa.model, 'sonnet', 'board 的定義要贏')
  assert.equal(a.qa.effort, 'max')
  // 沒被覆寫的角色仍然用預設
  assert.equal(a.junior.model, 'sonnet')
})

test('共用守則永遠在系統提示的最前面，agent 檔改不掉', async () => {
  const dir = await boardWith({
    'qa.md': '---\nname: qa\nmodel: haiku\n---\n只講這一句。',
  })
  const a = await loadAgents(dir)
  // 安全與協定相關的守則不放在 agent 檔裡，使用者刪不掉
  assert.match(a.qa.systemPrompt, /不要 commit、不要 push/)
  assert.match(a.qa.systemPrompt, /BLOCKED/)
  assert.match(a.qa.systemPrompt, /只講這一句。$/)
})

test('effort 沒寫時預設 high', () => {
  const spec = parseAgent('qa', '---\nname: q\nmodel: haiku\n---\n內容', 'x.md')
  assert.equal(spec.effort, 'high')
})

test('tools 可用逗號字串或 YAML 陣列', () => {
  const a = parseAgent('qa', '---\nname: q\nmodel: haiku\ntools: Read, Grep\n---\n內容', 'x.md')
  assert.deepEqual(a.tools, ['Read', 'Grep'])
  const b = parseAgent('qa', '---\nname: q\nmodel: haiku\ntools:\n  - Read\n  - Grep\n---\n內容', 'x.md')
  assert.deepEqual(b.tools, ['Read', 'Grep'])
})

test('缺 model → 明確報錯，不用預設值蒙混', () => {
  assert.throws(
    () => parseAgent('qa', '---\nname: q\n---\n內容', 'qa.md'),
    /缺少 model/,
  )
})

test('effort 值不合法 → 明確報錯', () => {
  assert.throws(
    () => parseAgent('qa', '---\nname: q\nmodel: haiku\neffort: 超高\n---\n內容', 'qa.md'),
    /effort 必須是/,
  )
})

test('沒有系統提示內容 → 報錯', () => {
  assert.throws(
    () => parseAgent('qa', '---\nname: q\nmodel: haiku\n---\n\n', 'qa.md'),
    /沒有系統提示內容/,
  )
})

test('沒有 frontmatter → 報錯', () => {
  assert.throws(() => parseAgent('qa', '只有內容', 'qa.md'), /缺少 frontmatter/)
})
