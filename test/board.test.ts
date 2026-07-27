import assert from 'node:assert/strict'
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
