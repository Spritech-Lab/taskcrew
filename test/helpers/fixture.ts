import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../../src/shell.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

export interface Step {
  text?: string
  cost?: number
  /** 相對於目標 repo 的路徑 → 新內容。讓假 agent 能真的改檔案 */
  apply?: Record<string, string>
  exit?: number
  isError?: boolean
}

export interface Fixture {
  boardDir: string
  repoDir: string
  cardPath: string
  /** 假 agent 每次呼叫收到的 --model / --effort，用來確認角色路由 */
  calls(): Promise<
    {
      model: string | null
      effort: string | null
      resume: string | null
      cwd: string
      files: string[]
    }[]
  >
  card(): Promise<string>
}

export interface FixtureOptions {
  /** 假 agent 的腳本，依序消費 */
  steps: Step[]
  /** 目標 repo 的初始檔案 */
  files: Record<string, string>
  /** 驗收指令 */
  verify: string
  autonomy?: string
  status?: string
  /** 主卡的 require_review */
  requireReview?: boolean
  /** 覆寫卡片的內文區塊 */
  sections?: Partial<Record<'Description' | 'Acceptance Criteria' | 'Implementation Plan', string>>
  /** board 層的 agent 定義覆寫。key 是檔名，例如 'qa.md' */
  agents?: Record<string, string>
  /** 額外的卡（測依賴 / 父子用）。key 是 id 後綴 */
  extraCards?: {
    id: string
    status: string
    /** 這張卡的父卡 */
    parent?: string
    /** 這張卡的 Runner Config 指向的 repo（給子卡用） */
    repo?: boolean
    verify?: string
    ac?: string
    /** 下游要等人親自驗過 */
    requireReview?: boolean
    dependencies?: string[]
  }[]
  dependencies?: string[]
}

const DEFAULT_DESCRIPTION = `
**要做什麼**
讓測試通過。

**不要做什麼**
- 不要動測試檔
`.trim()

const DEFAULT_AC = `- [ ] #1 測試要過 → \`test/run.js::t\``

export async function makeFixture(o: FixtureOptions): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'tc-fx-'))
  const boardDir = join(root, 'board')
  const repoDir = join(root, 'repo')
  const binDir = join(root, 'bin')

  // ── 目標 repo ──
  await mkdir(repoDir, { recursive: true })
  for (const [rel, content] of Object.entries(o.files)) {
    const p = join(repoDir, rel)
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, content, 'utf8')
  }
  await writeFile(join(repoDir, '.gitignore'), '.tc-fake*\n', 'utf8')
  await run('git', ['init', '-q', '-b', 'main'], { cwd: repoDir })
  await run('git', ['add', '-A'], { cwd: repoDir })
  await run(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'],
    { cwd: repoDir },
  )

  // ── 看板 ──
  await mkdir(join(boardDir, 'backlog', 'tasks'), { recursive: true })
  await writeFile(
    join(boardDir, 'backlog', 'config.yml'),
    'project_name: "fx"\nstatuses: ["開卡", "需求討論", "規劃中", "設計待批准", "阻塞", "待執行", "執行中", "執行完成回報", "完成"]\n',
    'utf8',
  )

  const cardPath = join(boardDir, 'backlog', 'tasks', 'task-1 - t.md')
  await writeFile(
    cardPath,
    card({
      id: 'TASK-1',
      status: o.status ?? '待執行',
      dependencies: o.dependencies ?? [],
      repoDir,
      verify: o.verify,
      autonomy: o.autonomy ?? 'none',
      requireReview: o.requireReview,
      sections: o.sections ?? {},
    }),
    'utf8',
  )

  for (const extra of o.extraCards ?? []) {
    const head = [
      '---',
      `id: ${extra.id}`,
      'title: x',
      `status: ${extra.status}`,
      'labels: []',
      'dependencies: []',
      ...(extra.parent ? [`parent_task_id: ${extra.parent}`] : []),
      '---',
      '',
    ].join('\n')
    const body = extra.repo
      ? card({
          id: extra.id,
          status: extra.status,
          dependencies: extra.dependencies ?? [],
          repoDir,
          verify: extra.verify ?? o.verify,
          autonomy: 'none',
          parent: extra.parent,
          requireReview: extra.requireReview,
          sections: extra.ac ? { 'Acceptance Criteria': extra.ac } : {},
        })
      : head
    await writeFile(join(boardDir, 'backlog', 'tasks', `task-${extra.id} - x.md`), body, 'utf8')
  }

  // ── board 層的 agent 覆寫 ──
  if (o.agents) {
    await mkdir(join(boardDir, 'agents'), { recursive: true })
    for (const [name, content] of Object.entries(o.agents)) {
      await writeFile(join(boardDir, 'agents', name), content, 'utf8')
    }
  }

  // ── 假 agent 放進 PATH 最前面 ──
  await mkdir(binDir, { recursive: true })
  const shim = join(binDir, 'claude')
  await writeFile(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "${join(HERE, 'fake-claude.js')}" "$@"\n`,
    'utf8',
  )
  await chmod(shim, 0o755)

  // 腳本與呼叫紀錄都放在目標 repo 裡 —— 沒有全域狀態，fixture 之間互不影響
  await writeFile(join(repoDir, '.tc-fake.json'), JSON.stringify(o.steps), 'utf8')
  const logPath = join(repoDir, '.tc-fake-calls.jsonl')

  if (!process.env.PATH?.startsWith(binDir)) {
    process.env.PATH = `${binDir}:${process.env.PATH}`
  }

  return {
    boardDir,
    repoDir,
    cardPath,
    async calls() {
      try {
        const raw = await readFile(logPath, 'utf8')
        return raw
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      } catch {
        return []
      }
    },
    card: () => readFile(cardPath, 'utf8'),
  }
}

function card(o: {
  id: string
  status: string
  dependencies: string[]
  repoDir: string
  verify: string
  autonomy: string
  parent?: string
  requireReview?: boolean
  sections: Partial<Record<string, string>>
}): string {
  const deps = o.dependencies.length ? `\n${o.dependencies.map((d) => `  - ${d}`).join('\n')}` : ' []'
  return `---
id: ${o.id}
title: t
status: ${o.status}
labels: []
dependencies:${deps}${o.parent ? `\nparent_task_id: ${o.parent}` : ''}
---

## Runner Config

<!-- RUNNER:BEGIN -->
\`\`\`yaml
project: ${o.repoDir}
base_branch: main
verify: ${JSON.stringify(o.verify)}
autonomy: ${o.autonomy}${o.requireReview ? '\nrequire_review: true' : ''}
\`\`\`
<!-- RUNNER:END -->

## Description

${o.sections['Description'] ?? DEFAULT_DESCRIPTION}

## Acceptance Criteria

${o.sections['Acceptance Criteria'] ?? DEFAULT_AC}

## Implementation Plan

${o.sections['Implementation Plan'] ?? '照原本的做法做。'}
`
}

/**
 * 產生一個測試腳本：吐出逐條 JSON 結果。
 * `pattern` 用 a=過 / x=掛，位置就是測試名稱。
 */
export function verifyScript(patternFile: string): string {
  return `node -e "const fs=require('fs');const p=fs.readFileSync('${patternFile}','utf8').trim();const tests=[...p].map((c,i)=>({name:'t'+i,passed:c==='a'}));console.log(JSON.stringify({tests}));process.exit(tests.every(t=>t.passed)?0:1)"`
}
