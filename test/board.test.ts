import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { stripLeadingHeading } from '../src/board.ts'

test('剝掉 agent 自己加的區塊標題', () => {
  const out = stripLeadingHeading('## Implementation Plan\n\n做法內容', 'Implementation Plan')
  assert.equal(out, '做法內容')
})

test('連續疊寫的標題一起剝掉', () => {
  const input = '## Implementation Plan\n\n# Implementation Plan：slug 處理\n\n## 現況\n\n內容'
  assert.equal(stripLeadingHeading(input, 'Implementation Plan'), '## 現況\n\n內容')
})

test('內容自己的標題不會被誤刪', () => {
  const input = '## 現況\n\nrepo 只有兩個檔案'
  assert.equal(stripLeadingHeading(input, 'Implementation Plan'), input)
})

test('標點與大小寫的差異不影響比對', () => {
  const input = '# implementation plan — 修 webhook\n\n內容'
  assert.equal(stripLeadingHeading(input, 'Implementation Plan'), '內容')
})

test('沒有標題時原樣回傳', () => {
  assert.equal(stripLeadingHeading('直接就是內容', 'Implementation Plan'), '直接就是內容')
})

test('整份都是重複標題時不會無限迴圈', () => {
  assert.equal(stripLeadingHeading('# Implementation Plan\n## Implementation Plan\n', 'Implementation Plan'), '')
})

test('區塊內文的子標題不會把區塊切斷', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { readCard } = await import('../src/board.ts')

  const dir = await mkdtemp(join(tmpdir(), 'tc-'))
  const p = join(dir, 'task-1 - t.md')
  await writeFile(
    p,
    `---
id: TASK-1
title: t
status: 待執行
---

## Implementation Plan

## 現況

repo 只有兩個檔案

## 做法

改 slug.js

## Acceptance Criteria

- [ ] 一條 → \`t::a\`
`,
    'utf8',
  )
  const card = await readCard(p)
  // plan 必須完整含子標題，而不是在「## 現況」處被切斷
  assert.match(card.sections['Implementation Plan'] ?? '', /現況[\s\S]*做法/)
  // 但真正的下一個區塊仍要被正確切出來
  assert.match(card.sections['Acceptance Criteria'] ?? '', /一條/)
})

// ── 看板順序 ────────────────────────────────────────────────────────────

test('照 ordinal 排，不照 ID —— 你在 UI 上拖卡改的就是 ordinal', async () => {
  const { byBoardOrder } = await import('../src/board.ts')
  const card = (id: string, ordinal?: number) => ({ id, ordinal }) as any

  // TASK-3 被拖到最前面。照 ID 排的話它會排最後 —— 那就等於忽略你的操作。
  const sorted = [card('TASK-1', 2000), card('TASK-2', 3000), card('TASK-3', 1000)]
    .sort(byBoardOrder)
    .map((c) => c.id)
  assert.deepEqual(sorted, ['TASK-3', 'TASK-1', 'TASK-2'])
})

test('沒有 ordinal 的卡排最後，同順位再比 ID', async () => {
  const { byBoardOrder } = await import('../src/board.ts')
  const card = (id: string, ordinal?: number) => ({ id, ordinal }) as any

  const sorted = [card('TASK-9'), card('TASK-2', 1000), card('TASK-1')]
    .sort(byBoardOrder)
    .map((c) => c.id)
  assert.deepEqual(sorted, ['TASK-2', 'TASK-1', 'TASK-9'], '手寫的卡可能沒這個欄位')
})

test('ordinal 相同時用數字語意比 ID，不是字串比較', async () => {
  const { byBoardOrder } = await import('../src/board.ts')
  const card = (id: string, ordinal?: number) => ({ id, ordinal }) as any

  const sorted = [card('TASK-10', 1000), card('TASK-2', 1000)].sort(byBoardOrder).map((c) => c.id)
  assert.deepEqual(sorted, ['TASK-2', 'TASK-10'], '字串比較會把 TASK-10 排在 TASK-2 前面')
})

test('取代最後一個區塊時不會變成附加 —— JS 沒有 \\z', async () => {
  // 原本用 `(?=^##\s|\z)` 判邊界，但 JS 的 `\z` 是字母 z 不是字串結尾。
  // 於是最後一個區塊（Implementation Plan / Notes 正好都是）內容裡沒有 z 時
  // 就比對不到，變成附加，卡片上出現兩個同名區塊。
  const { upsertSection, readCard } = await import('../src/board.ts')
  const dir = await mkdtemp(join(tmpdir(), 'tc-up-'))
  const p = join(dir, 'c.md')
  await writeFile(p, '---\nid: T-1\ntitle: t\nstatus: 待執行\n---\n\n## Description\n\n描述\n\n## Implementation Plan\n\n待產出\n', 'utf8')

  const card = await readCard(p)
  await upsertSection(card, 'Implementation Plan', '新的做法')

  const raw = await readFile(p, 'utf8')
  assert.equal((raw.match(/^## Implementation Plan$/gm) ?? []).length, 1, '不能有兩個同名區塊')
  assert.match(raw, /新的做法/)
  assert.doesNotMatch(raw, /待產出/, '舊內容要被換掉')
  assert.match(raw, /## Description\n\n描述/, '相鄰區塊不能被動到')
})

test('取代中間的區塊，後面的區塊要留著', async () => {
  const { upsertSection, readCard } = await import('../src/board.ts')
  const dir = await mkdtemp(join(tmpdir(), 'tc-up2-'))
  const p = join(dir, 'c.md')
  await writeFile(p, '---\nid: T-1\ntitle: t\nstatus: 待執行\n---\n\n## Description\n\n舊描述\n\n## Acceptance Criteria\n\n- [ ] #1 x\n', 'utf8')

  const card = await readCard(p)
  await upsertSection(card, 'Description', '新描述')

  const raw = await readFile(p, 'utf8')
  assert.match(raw, /新描述/)
  assert.match(raw, /## Acceptance Criteria\n\n- \[ \] #1 x/, '後面的區塊要完整留著')
})
