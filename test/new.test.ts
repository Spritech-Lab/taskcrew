import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readCard } from '../src/board.ts'
import { checkGate } from '../src/gate.ts'
import { newCard } from '../src/new.ts'
import { run } from '../src/shell.ts'

/**
 * 樣板存在的唯一理由是「照著填就能過閘門」。
 *
 * 所以要釘死的不是「有沒有產出檔案」，是**樣板和閘門不會分岔** ——
 * 分岔的話它教的就是錯的，比沒有還糟。
 */

const hasBacklog = (await run('which', ['backlog'])).code === 0

async function board(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tc-new-'))
  await run('git', ['init', '-q'], { cwd: dir })
  await run('backlog', ['init', 'fx', '--defaults'], { cwd: dir })
  const cfg = join(dir, 'backlog', 'config.yml')
  const s = await readFile(cfg, 'utf8')
  await writeFile(
    cfg,
    s
      .replace('default_status: "To Do"', 'default_status: "開卡"')
      .replace(
        'statuses: ["To Do", "In Progress", "Done"]',
        'statuses: ["開卡", "需求討論", "規劃中", "設計待批准", "阻塞", "待執行", "執行中", "執行完成回報", "完成"]',
      ),
    'utf8',
  )
  return dir
}

test('產出的骨架，Runner Config 解析得出來', { skip: !hasBacklog && '沒有 backlog CLI' }, async () => {
  const dir = await board()
  const path = await newCard({ boardDir: dir, title: '一張卡', project: '~/code/x' })
  const card = await readCard(path)

  // YAML 註解不能把解析弄壞 —— 樣板裡每個欄位都帶說明
  assert.ok(card.runner, 'Runner Config 要解析得出來')
  assert.equal(card.runner!.project, '~/code/x')
  assert.equal(card.runner!.base_branch, 'main')
  assert.deepEqual(card.runner!.autonomy, { kind: 'propose' })
})

test('骨架填完就過閘門 —— 樣板和閘門不能分岔', { skip: !hasBacklog && '沒有 backlog CLI' }, async () => {
  const dir = await board()
  const repo = await mkdtemp(join(tmpdir(), 'tc-repo-'))
  await mkdir(join(repo, 'test'), { recursive: true })
  await writeFile(join(repo, 'test', 'run.js'), '', 'utf8')
  await run('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  await run('git', ['add', '-A'], { cwd: repo })
  await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i'], { cwd: repo })

  const path = await newCard({ boardDir: dir, title: '一張卡', project: repo })

  // 照樣板的指示把佔位文字換掉 —— 這就是使用者會做的事
  const raw = await readFile(path, 'utf8')
  await writeFile(
    path,
    raw
      .replace('（為什麼要做這件事）', '舊的登入流程沒有防重放')
      .replace('（具體、可驗證的描述）', '加上 nonce 檢查')
      .replace(
        '- （閘門檢查這一段存在。無人看管時，擋掉災難最多的就是它 ——\n   允許清單一定會漏，禁止清單不會）',
        '- 不要動 test/ 底下的檔案',
      )
      .replace('- [ ] #1 （條件） → `test/run.js::測試名稱`', '- [ ] #1 重放會被擋 → `test/run.js::replay-blocked`')
      .replace(
        '（留空。跑 `taskcrew plan` 讓 PM 產出，你在「設計待批准」那一欄審。\n　審過就把卡拖到「待執行」—— 卡片位置本身就是批准，不需要額外欄位）',
        '在中介層加 nonce 表',
      ),
    'utf8',
  )

  const card = await readCard(path)
  const verdict = await checkGate(card, [card])
  assert.equal(
    verdict.kind,
    'pass',
    `填完的骨架應該過閘門，實際：${JSON.stringify(verdict)}`,
  )
})

test('父卡 / 依賴會傳給 backlog，ID 自動階層化', { skip: !hasBacklog && '沒有 backlog CLI' }, async () => {
  const dir = await board()
  await newCard({ boardDir: dir, title: '模組' })
  const child = await newCard({ boardDir: dir, title: '功能', parent: 'TASK-1' })
  const grand = await newCard({ boardDir: dir, title: '子任務', parent: 'TASK-1.1' })

  assert.equal((await readCard(child)).id, 'TASK-1.1')
  assert.equal((await readCard(grand)).id, 'TASK-1.1.1', '三層要疊得起來')
  assert.equal((await readCard(grand)).parentTaskId, 'TASK-1.1')
})
