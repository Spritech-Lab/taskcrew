import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readCard, upsertSection } from '../src/board.ts'
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

  // 照樣板的指示把 ⟨⟩ 裡的東西換掉 —— 這就是使用者（或建卡的 agent）會做的事
  const raw = await readFile(path, 'utf8')
  const filled = raw
    // 驗收條件要保持「條件 → 測試引用」的形狀，所以單獨換
    .replace(
      /- \[ \] #1 ⟨[\s\S]*?⟩ → ⟨[\s\S]*?⟩/,
      '- [ ] #1 重放會被擋 → `test/run.js::replay-blocked`',
    )
    // 其餘的佔位一律換成真內容
    .replace(/⟨[\s\S]*?⟩/g, '真的填了')
  await writeFile(path, filled, 'utf8')

  const card = await readCard(path)
  const verdict = await checkGate(card, [card])
  assert.equal(
    verdict.kind,
    'pass',
    `填完的骨架應該過閘門，實際：${JSON.stringify(verdict)}`,
  )
})

test('完全沒填的骨架會被閘門擋下 —— 這一項擋的是建卡的人', { skip: !hasBacklog && '沒有 backlog CLI' }, async () => {
  // 佔位文字自己滿足了其他檢查：「不要做什麼」那段的說明裡就寫著
  // `**不要做什麼**`，驗收條件的範本裡就有 `→ 測試引用`。
  // 沒有第八項的話，一張完全沒填的卡會被判合格，agent 拿到佔位文字當需求。
  const dir = await board()
  const repo = await mkdtemp(join(tmpdir(), 'tc-repo-'))
  await run('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  await writeFile(join(repo, 'x'), 'x', 'utf8')
  await run('git', ['add', '-A'], { cwd: repo })
  await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i'], { cwd: repo })

  // repo 指對，把「目錄不存在」那項排除掉，才看得出剩下幾項對空白內容的反應
  const path = await newCard({ boardDir: dir, title: '沒填的卡', project: repo })
  const v = await checkGate(await readCard(path), [])

  assert.equal(v.kind, 'fail', '沒填的卡絕對不能過')
  assert.match(
    (v as { problems: string[] }).problems.join('\n'),
    /沒填完/,
    '要說清楚是沒填完，不是欄位格式錯',
  )
})

// 每個區塊都要各自被檢查。只測「有一個沒填就擋」是不夠的 ——
// 那樣把驗收條件從檢查清單裡拿掉也不會有測試變紅（變異測試抓到過）。
for (const section of ['Description', 'Acceptance Criteria', 'Implementation Plan']) {
  test(`只有「${section}」沒填也要擋`, { skip: !hasBacklog && '沒有 backlog CLI' }, async () => {
    const dir = await board()
    const repo = await mkdtemp(join(tmpdir(), 'tc-repo-'))
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    await writeFile(join(repo, 'x'), 'x', 'utf8')
    await run('git', ['add', '-A'], { cwd: repo })
    await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i'], { cwd: repo })

    const path = await newCard({ boardDir: dir, title: '一張卡', project: repo })
    const raw = await readFile(path, 'utf8')
    await writeFile(
      path,
      raw
        .replace(
          /- \[ \] #1 ⟨[\s\S]*?⟩ → ⟨[\s\S]*?⟩/,
          '- [ ] #1 重放會被擋 → `test/run.js::replay-blocked`',
        )
        .replace(/⟨[\s\S]*?⟩/g, '真的填了'),
      'utf8',
    )

    // 只把這一個區塊改回沒填的樣子
    const card = await readCard(path)
    await upsertSection(card, section, section === 'Acceptance Criteria'
      ? '- [ ] #1 ⟨條件⟩ → ⟨`test/run.js::測試名`⟩'
      : '⟨還沒想好⟩')

    const v = await checkGate(await readCard(path), [])
    assert.equal(v.kind, 'fail', `${section} 沒填就該被擋`)
    assert.match((v as { problems: string[] }).problems.join('\n'), /沒填完/)
  })
}

test('父卡 / 依賴會傳給 backlog，ID 自動階層化', { skip: !hasBacklog && '沒有 backlog CLI' }, async () => {
  const dir = await board()
  await newCard({ boardDir: dir, title: '模組' })
  const child = await newCard({ boardDir: dir, title: '功能', parent: 'TASK-1' })
  const grand = await newCard({ boardDir: dir, title: '子任務', parent: 'TASK-1.1' })

  assert.equal((await readCard(child)).id, 'TASK-1.1')
  assert.equal((await readCard(grand)).id, 'TASK-1.1.1', '三層要疊得起來')
  assert.equal((await readCard(grand)).parentTaskId, 'TASK-1.1')
})
