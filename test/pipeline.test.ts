import assert from 'node:assert/strict'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import { loadAgents } from '../src/agents.ts'
import { readCard } from '../src/board.ts'
import { LocalDispatcher } from '../src/dispatch.ts'
import { planAll } from '../src/plan.ts'
import { drain } from '../src/runner.ts'
import { run } from '../src/shell.ts'
import { makeFixture, verifyScript, type Step } from './helpers/fixture.ts'

/**
 * 整合測試：用假 agent 把產線的控制流釘死。
 *
 * 測的是「什麼情況下該升級」，不是「agent 寫得好不好」。
 * `pattern` 檔的內容決定驗收結果（a=過 / x=掛），假 agent 靠改它來模擬開發。
 */

const VERIFY = verifyScript('./pattern')

/** 語意糖：agent 這一步把驗收結果改成某個樣子 */
const writes = (pattern: string, text = '做完了'): Step => ({
  text,
  cost: 0.01,
  apply: { pattern },
})
const says = (text: string): Step => ({ text, cost: 0.01 })

async function runFixture(o: Parameters<typeof makeFixture>[0]) {
  const fx = await makeFixture(o)
  const lines: string[] = []
  const log = (l: string) => lines.push(l)
  // 整合測試走本機 dispatcher —— 匯流排那條路徑另外測，不然每個測試都要 Redis
  const dispatch = new LocalDispatcher(await loadAgents(fx.boardDir), log)
  const summary = await drain({ boardDir: fx.boardDir, dispatch, log })
  return { fx, summary, log: lines.join('\n') }
}

test('一輪就過：junior → 減法 → QA', async () => {
  const { fx, summary } = await runFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    steps: [writes('aaa'), says('減完了'), says('符合要求')],
  })

  assert.equal(summary.done, 1)
  const card = await readCard(fx.cardPath)
  assert.equal(card.status, '執行完成回報')

  // 角色路由：開發用 sonnet，減法與 QA 分別是 opus / haiku
  const calls = await fx.calls()
  assert.deepEqual(
    calls.map((c) => c.model),
    ['sonnet', 'opus', 'haiku'],
  )
})

test('junior 沒做出來 → senior 接手（內層第二輪換的是人，不是重試）', async () => {
  const { fx, summary } = await runFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    // 輪1 junior 只修好一條；輪2 senior 全修好
    steps: [writes('axx'), writes('aaa'), says('符合要求')],
  })

  assert.equal(summary.done, 1)
  const calls = await fx.calls()
  assert.equal(calls[0].model, 'sonnet', '輪 1 應該是 junior')
  assert.equal(calls[1].model, 'opus', '輪 2 應該換成 senior 接手')
  assert.equal(calls[1].effort, 'xhigh')
})

test('同一批測試一直掛 → stuck → PM 換方案 → 新分支從頭來', async () => {
  const { fx, summary, log } = await runFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    autonomy: 'replan:1',
    steps: [
      writes('axx'), // 方案1 輪1 junior
      writes('axx'), // 方案1 輪2 senior —— 失敗集合沒動 = stuck
      says('REPLACE:'), // PM 判定結構有問題（這次的 plan 會被丟掉）
      says('乾淨 session 裡重想的做法'), // PM 在新 session 產出替代方案
      writes('aaa'), // 方案2 輪1 junior
      says('減完了'), // senior 減法
      says('符合要求'), // QA
    ],
  })

  assert.equal(summary.done, 1)

  // 排除清單累積了失敗的方案 —— 這是 PM 下次的依據，也是人判斷的材料。
  // 關鍵是**升級的理由**：必須是形狀判定，不是「輪次用盡」——
  // 兩者都會換方案，但只有前者證明 shape 分析真的在起作用。
  const card = await readCard(fx.cardPath)
  const excluded = card.sections['Excluded Approaches'] ?? ''
  assert.match(excluded, /方案 1/)
  assert.match(excluded, /同一批/, '升級理由要是 stuck 形狀')
  assert.doesNotMatch(excluded, /輪次用盡/, '不該是靠跑完輪次才換方案')
  assert.match(log, /→ 換方案/)

  // 換方案 = 新分支，而且從 base_branch 乾淨長出來
  const branches = await run('git', ['branch', '--format=%(refname:short)'], { cwd: fx.repoDir })
  assert.match(branches.stdout, /task-1-attempt-1/)
  assert.match(branches.stdout, /task-1-attempt-2/)
})

test('autonomy: propose —— PM 想得出新方案，但不准自己執行', async () => {
  const { fx, summary } = await runFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    autonomy: 'propose',
    steps: [
      writes('axx'),
      writes('axx'),
      says('REPLACE:'),
      says('這次改用另一種做法'), // 乾淨 session 產出的才是真正採用的
    ],
  })

  assert.equal(summary.proposed, 1)
  assert.equal(summary.done, 0)

  const card = await readCard(fx.cardPath)
  assert.equal(card.status, '設計待批准', '球要回到人手上')
  assert.match(card.sections['Implementation Plan'] ?? '', /另一種做法/)
})

test('PLAN_INFEASIBLE：不等輪次跑完就升級', async () => {
  const { fx, summary } = await runFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    steps: [says('PLAN_INFEASIBLE: plan 假設的檔案不存在')],
  })

  assert.equal(summary.failed, 1)
  const calls = await fx.calls()
  assert.equal(calls.length, 1, '宣告不可行之後不該再呼叫任何 agent')

  const card = await readCard(fx.cardPath)
  assert.match(card.sections['Implementation Notes'] ?? '', /不可行/)
})

test('QA 判定 PLAN_INADEQUATE：測試全過也不算過', async () => {
  const { fx, summary } = await runFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    steps: [writes('aaa'), says('減完了'), says('PLAN_INADEQUATE: 這個做法達不到第三條')],
  })

  assert.equal(summary.done, 0)
  assert.equal(summary.failed, 1)
  const card = await readCard(fx.cardPath)
  assert.match(card.sections['Implementation Notes'] ?? '', /方案不足/)
})

test('依賴未完成 → 阻塞，而且完全不呼叫 agent', async () => {
  const { fx, summary } = await runFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    dependencies: ['TASK-9'],
    extraCards: [{ id: 'TASK-9', status: '待執行' }],
    steps: [],
  })

  assert.equal(summary.blocked, 1)
  assert.equal((await fx.calls()).length, 0)
  assert.equal((await readCard(fx.cardPath)).status, '阻塞')
})

test('依賴已完成 → 放行', async () => {
  const { summary } = await runFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    dependencies: ['TASK-9'],
    extraCards: [{ id: 'TASK-9', status: '完成' }],
    steps: [writes('aaa'), says('減完了'), says('符合要求')],
  })
  assert.equal(summary.done, 1)
  assert.equal(summary.blocked, 0)
})

test('閘門擋掉缺「不要做什麼」的卡，且不呼叫 agent', async () => {
  const { fx, summary } = await runFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    sections: { Description: '**要做什麼**\n隨便做做' },
    steps: [],
  })

  assert.equal(summary.rejected, 1)
  assert.equal((await fx.calls()).length, 0)
})

test('閘門擋掉沒掛 test case 的驗收條件', async () => {
  const { summary, log } = await runFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    sections: { 'Acceptance Criteria': '- [ ] #1 要能動' },
    steps: [],
  })

  assert.equal(summary.rejected, 1)
  assert.match(log, /test case/)
})

test('通過才 commit，而且只在專用分支上 —— base_branch 不被動到', async () => {
  const { fx } = await runFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    steps: [writes('aaa'), says('減完了'), says('符合要求')],
  })

  const onMain = await run('git', ['show', 'main:pattern'], { cwd: fx.repoDir })
  assert.equal(onMain.stdout.trim(), 'xxx', 'main 應該完全沒被動到')

  const onBranch = await run('git', ['show', 'task/task-1-attempt-1:pattern'], {
    cwd: fx.repoDir,
  })
  assert.equal(onBranch.stdout.trim(), 'aaa')
})

test('未通過不會產出成果分支，但殘骸留在它自己的分支上', async () => {
  // 原本的做法是「失敗就完全不 commit，改動留在工作區」。那是錯的：
  // `git checkout -B 新分支 base` 會把未提交的變更**一起帶到下一張卡的分支**，
  // 於是一張失敗的卡會悄悄污染下一張。殘骸要留，但要留在它自己的分支上。
  const { fx } = await runFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    steps: [writes('axx'), writes('axx')],
  })

  // 失敗不能看起來像成功 —— 下游認的是這個名字
  const accepted = await run('git', ['rev-parse', '--verify', '--quiet', 'task/task-1'], {
    cwd: fx.repoDir,
  })
  assert.notEqual(accepted.code, 0, '沒通過就不該有成果分支')

  // 但做到哪裡要看得到，而且是在它自己的分支上
  const residue = await run('git', ['show', 'task/task-1-attempt-1:pattern'], { cwd: fx.repoDir })
  assert.equal(residue.stdout.trim(), 'axx', '殘骸要 commit 在該卡的分支上留作線索')

  // 而且 repo 收回乾淨的起點，不會把東西帶給下一張卡
  const branch = await run('git', ['branch', '--show-current'], { cwd: fx.repoDir })
  assert.equal(branch.stdout.trim(), 'main')
  const status = await run('git', ['status', '--porcelain'], { cwd: fx.repoDir })
  assert.equal(status.stdout.trim(), '', '工作區要乾淨')
})

test('前一張卡的殘骸不會被帶到下一張卡的分支上', async () => {
  // 這是上面那條的真正代價，值得單獨釘死：兩張卡連著跑，第一張失敗。
  const fx = await makeFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    extraCards: [{ id: 'TASK-2', status: '待執行', repo: true }],
    steps: [
      // TASK-1 失敗，留下一個 junk 檔案在工作區（沒 commit）
      { text: '做完了', cost: 0.01, apply: { pattern: 'axx', junk: 'TASK-1 的殘骸' } },
      { text: '做完了', cost: 0.01, apply: { pattern: 'axx' } },
      says('HANDBACK: 需求本身有洞'), // PM 交回人，TASK-1 到此為止
      // TASK-2 成功，而且完全不碰 junk
      writes('aaa'), says('減完了'), says('符合要求'),
    ],
  })

  const d = new LocalDispatcher(await loadAgents(fx.boardDir), () => {})
  await drain({ boardDir: fx.boardDir, dispatch: d, log: () => {} })

  // TASK-1 留下的 junk 檔案完全不該出現在 TASK-2 的成果裡。
  // 用一個 TASK-2 不會碰的檔案才看得出洩漏 —— 兩張卡都會動的檔案
  // 會被後面那張覆蓋掉，洩漏就藏起來了。
  const leaked = await run('git', ['cat-file', '-e', 'task/task-2:junk'], { cwd: fx.repoDir })
  assert.notEqual(leaked.code, 0, 'TASK-1 的殘骸不該出現在 TASK-2 的分支上')
})

// ── 修正 vs 換方案 ──────────────────────────────────────────────────────
//
// 這兩條路對分支的處理完全相反，猜錯的代價是把一份大致正確的方案
// 連同它的成果一起丟掉。所以要分別釘死。

test('PM 判定 REVISE：同一條分支接著做，不丟成果', async () => {
  const { fx, summary, log } = await runFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    steps: [
      writes('axx'), // 輪1 junior
      writes('axx'), // 輪2 senior → stuck
      says('REVISE:\n\n細節修正：檔名應該是 pattern'), // PM 說只是細節錯
      writes('aaa'), // v2 輪1 junior
      says('減完了'),
      says('符合要求'),
    ],
  })

  assert.equal(summary.done, 1)
  assert.match(log, /PM 修正 plan（v2）/)

  // 關鍵：修正不開新分支
  const branches = await run('git', ['branch', '--format=%(refname:short)'], { cwd: fx.repoDir })
  assert.match(branches.stdout, /task-1-attempt-1/)
  assert.doesNotMatch(branches.stdout, /attempt-2/, '修正不該開新分支')

  const card = await readCard(fx.cardPath)
  // 修正不進排除清單 —— 那份清單是給 PM 換方案時看的，塞滿微調就找不到重點
  assert.equal(card.sections['Excluded Approaches'], undefined)
  // 但 plan 要被更新
  assert.match(card.sections['Implementation Plan'] ?? '', /細節修正/)
})

test('PM 判定 REPLACE：開新分支，舊 code 丟掉', async () => {
  const { fx, summary } = await runFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    autonomy: 'replan:1',
    steps: [
      writes('axx'),
      writes('axx'),
      says('REPLACE:'),
      says('結構就錯了，換一個做法'),
      writes('aaa'),
      says('減完了'),
      says('符合要求'),
    ],
  })

  assert.equal(summary.done, 1)
  const branches = await run('git', ['branch', '--format=%(refname:short)'], { cwd: fx.repoDir })
  assert.match(branches.stdout, /attempt-2/, '換方案要開新分支')

  const card = await readCard(fx.cardPath)
  assert.match(card.sections['Excluded Approaches'] ?? '', /方案 1/)
})

test('PM 判定 HANDBACK：不換方案，直接交回人', async () => {
  const { fx, summary } = await runFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    autonomy: 'replan:2',
    steps: [
      writes('axx'),
      writes('axx'),
      says('HANDBACK: 驗收條件第 2 與第 3 條互相矛盾'),
    ],
  })

  assert.equal(summary.failed, 1)
  assert.equal(summary.done, 0)
  // 交回人就停，不該再燒錢換方案
  assert.equal((await fx.calls()).length, 3)
  assert.match((await readCard(fx.cardPath)).sections['Implementation Notes'] ?? '', /交回人/)
})

test('修正次數用完 → 自動改為換方案，不會無限修下去', async () => {
  const { summary, log } = await runFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    steps: [
      writes('axx'), writes('axx'), says('REVISE:\n\n第一次修正'),
      writes('axx'), writes('axx'), says('REVISE:\n\n第二次修正'),
      writes('axx'), writes('axx'),
      // 到這裡 planVersion=3 > MAX_REVISIONS=2，不會再問 PM
    ],
  })

  assert.equal(summary.failed, 1)
  assert.match(log, /修正 2 次仍未通過 → 改為換方案/)
})

test('PM 回覆無法解析 → 失敗並說明，不亂猜一個決定', async () => {
  const { summary, log } = await runFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    steps: [writes('axx'), writes('axx'), says('嗯我覺得可以再試試看')],
  })

  assert.equal(summary.failed, 1)
  assert.match(log, /沒有給出可解析的決定/)
})

test('board 層的 agent 覆寫會真的影響產線呼叫的模型', async () => {
  const { fx, summary } = await runFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    // 把 QA 從 haiku 換成 sonnet、effort 拉到 max
    agents: { 'qa.md': '---\nname: qa\nmodel: sonnet\neffort: max\n---\n你是 QA。' },
    steps: [writes('aaa'), says('減完了'), says('符合要求')],
  })

  assert.equal(summary.done, 1)
  const calls = await fx.calls()
  assert.deepEqual(
    calls.map((c) => `${c.model}/${c.effort}`),
    ['sonnet/high', 'opus/xhigh', 'sonnet/max'],
    '第三個呼叫是 QA —— 應該用 board 覆寫後的 sonnet/max，不是預設的 haiku/medium',
  )
})

// ── session 延續 ────────────────────────────────────────────────────────
//
// 常駐的價值在於 agent 記得這個 repo。但換方案時那份記憶會變成負債 ——
// 分支已經重設回 base_branch，它記得的「我改過什麼」全是假的。

test('同一次執行裡，第二張卡的 agent 續接前一張的 session', async () => {
  const { fx } = await runFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    steps: [
      writes('aaa'), says('減完了'), says('符合要求'), // 卡 1
      writes('aaa'), says('減完了'), says('符合要求'), // 卡 2（同 repo）
    ],
    extraCards: [{ id: 'TASK-2', status: '完成' }],
  })

  const calls = await fx.calls()
  // 第一次一定是新的；同角色的第二次應該帶 --resume
  assert.equal(calls[0].resume, null, '第一次呼叫沒有 session 可續接')
  const juniorCalls = calls.filter((c) => c.model === 'sonnet')
  if (juniorCalls.length > 1) {
    assert.ok(juniorCalls[1].resume, 'junior 第二次該續接同一個 session')
  }
})

test('換方案時所有角色重置 session —— 那個世界已經不存在了', async () => {
  const { fx, summary } = await runFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    autonomy: 'replan:1',
    steps: [
      writes('axx'), // 方案1 輪1 junior
      writes('axx'), // 方案1 輪2 senior → stuck
      says('REPLACE:'), // PM 判定（帶著脈絡）
      says('乾淨 session 裡重想的做法'), // PM 換方案（乾淨）
      writes('aaa'), // 方案2 輪1 junior
      says('減完了'),
      says('符合要求'),
    ],
  })

  assert.equal(summary.done, 1)
  const calls = await fx.calls()

  // 索引 2 是 PM 的判斷（要帶脈絡，但那是它第一次，所以沒有 resume）
  // 索引 3 是 PM 換方案 —— 就算前一次已經建立 session，這次也不該續接
  assert.equal(calls[3].resume, null, 'PM 換方案要在乾淨 session 裡想')

  // 索引 4 是方案 2 的 junior —— 方案 1 已經建立過 session，但這次要重置
  assert.equal(calls[4].resume, null, '換方案後 junior 也要重置')
})

test('修正時不重置 —— PM 在調整自己的方案，記得原本的思路正是必要的', async () => {
  const { fx, summary } = await runFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    steps: [
      writes('axx'),
      writes('axx'),
      says('REVISE:\n\n細節修正'),
      writes('aaa'),
      says('減完了'),
      says('符合要求'),
    ],
  })

  assert.equal(summary.done, 1)
  const calls = await fx.calls()
  // 索引 3 是修正後的 junior —— 同一條分支、同一個方案，成果還在，該續接
  assert.ok(calls[3].resume, '修正後 junior 該續接，不是從零開始')
})

test('一張卡不會被別張卡的測試擋住 —— 只看自己驗收條件涵蓋的', async () => {
  const { summary } = await runFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    // 這張卡只負責 t0；t1/t2 是別張卡的工作，跑完仍然是紅的
    sections: { 'Acceptance Criteria': '- [ ] #1 只管這條 → `test/run.js::t0`' },
    steps: [writes('axx'), says('減完了'), says('符合要求')],
  })

  assert.equal(summary.done, 1, 't0 過了就該算過，不該被 t1/t2 擋住')
})

// ── 父子卡 ──────────────────────────────────────────────────────────────
//
// 父卡的工作是**整合**：等所有子卡被你驗過，把它們的成果合起來，
// 跑只有合起來才驗得到的整體驗收。

test('父卡在子卡完成前被擋住，而且不呼叫任何 agent', async () => {
  const { fx, summary } = await runFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    // TASK-1 是父卡（fixture 的主卡），TASK-1.1 是還沒完成的子卡
    extraCards: [{ id: 'TASK-1.1', status: '待執行', parent: 'TASK-1' }],
    steps: [],
  })

  assert.equal(summary.blocked, 1)
  assert.equal((await fx.calls()).length, 0, '被擋住就不該花任何錢')
  assert.equal((await readCard(fx.cardPath)).status, '阻塞')
})

test('子卡全部完成後，父卡把它們的成果合進來再跑整體驗收', async () => {
  const fx = await makeFixture({
    files: { pattern: 'xx', other: 'start' },
    verify: VERIFY,
    // 父卡的驗收條件只看 t0；子卡負責的是 t1
    sections: { 'Acceptance Criteria': '- [ ] #1 整體 → `test/run.js::t0`' },
    extraCards: [{ id: 'TASK-1.1', status: '完成', parent: 'TASK-1' }],
    steps: [writes('aa'), says('減完了'), says('符合要求')],
  })

  // 模擬子卡跑完留下的成果分支：它在 other 檔案上做了改動
  await run('git', ['checkout', '-q', '-b', 'task/task-1.1'], { cwd: fx.repoDir })
  await writeFile(`${fx.repoDir}/other`, '子卡的成果', 'utf8')
  await run('git', ['add', '-A'], { cwd: fx.repoDir })
  await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'child'], {
    cwd: fx.repoDir,
  })
  await run('git', ['checkout', '-q', 'main'], { cwd: fx.repoDir })

  const lines: string[] = []
  const log = (l: string) => lines.push(l)
  const dispatch = new LocalDispatcher(await loadAgents(fx.boardDir), log)
  const summary = await drain({ boardDir: fx.boardDir, dispatch, log })

  assert.equal(summary.done, 1, lines.join('\n'))

  // 父卡的分支上要看得到子卡的成果 —— 那就是「整合」的意思
  const merged = await run('git', ['show', 'task/task-1:other'], { cwd: fx.repoDir })
  assert.equal(merged.stdout.trim(), '子卡的成果', '子卡的改動要被合進父卡的成果')
})

test('手動標記完成的子卡沒有成果分支時，說出來而不是當掉', async () => {
  const { summary, log } = await runFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    dependencies: ['TASK-9'],
    // 這張卡被人手動拖到「完成」，從沒真的跑過，所以沒有 task/task-9 分支
    extraCards: [{ id: 'TASK-9', status: '完成' }],
    steps: [writes('aaa'), says('減完了'), says('符合要求')],
  })

  assert.equal(summary.done, 1, '不該因為缺分支就整個失敗')
  assert.match(log, /沒有成果分支/, '要讓人知道 plan 可能假設了不存在的東西')
})

// ── 父卡的規劃時機 ──────────────────────────────────────────────────────
//
// 實跑撞出來的：父卡要串接的是子卡的**實際介面**，子卡沒做完那些介面
// 還不存在，PM 只能瞎猜。閘門已經擋在執行階段，規劃階段也要擋。

test('子卡沒完成時，父卡不送去規劃，也不花錢', async () => {
  const fx = await makeFixture({
    files: { pattern: 'x' },
    verify: VERIFY,
    status: '規劃中',
    extraCards: [{ id: 'TASK-1.1', status: '待執行', parent: 'TASK-1' }],
    steps: [says('# Plan\n照做')],
  })

  const lines: string[] = []
  const d = new LocalDispatcher(await loadAgents(fx.boardDir), (l) => lines.push(l))
  const s = await planAll({ boardDir: fx.boardDir, dispatch: d, log: (l) => lines.push(l) })

  assert.equal(s.waiting, 1, lines.join('\n'))
  assert.equal(s.planned, 0)
  assert.equal((await fx.calls()).length, 0, '等子卡就不該呼叫 PM')
  assert.equal((await readCard(fx.cardPath)).status, '規劃中', '留在原地，不改狀態')
})

test('子卡都完成後，父卡才輪到規劃', async () => {
  const fx = await makeFixture({
    files: { pattern: 'x' },
    verify: VERIFY,
    status: '規劃中',
    extraCards: [{ id: 'TASK-1.1', status: '完成', parent: 'TASK-1' }],
    steps: [says('# Plan\n把子模組串起來')],
  })

  const lines: string[] = []
  const d = new LocalDispatcher(await loadAgents(fx.boardDir), (l) => lines.push(l))
  const s = await planAll({ boardDir: fx.boardDir, dispatch: d, log: (l) => lines.push(l) })

  assert.equal(s.waiting, 0, lines.join('\n'))
  assert.equal(s.planned, 1)
  assert.equal((await readCard(fx.cardPath)).status, '設計待批准')
})

// ── 下游什麼時候可以開工 ─────────────────────────────────────────────────
//
// 預設不等人。一條四張卡的依賴鏈若每段都要人點一次，無人看管執行就失去意義 ——
// 晚上掛著跑，早上看到的會是「做完 1 張，卡住 3 張」。

/** 造一個「跑完且通過」的上游：狀態在執行完成回報，而且有成果分支。 */
async function upstreamPassed(repoDir: string, id: string): Promise<void> {
  await run('git', ['branch', '-f', `task/${id.toLowerCase()}`, 'main'], { cwd: repoDir })
}

test('依賴跑完且通過就放行，不必等人驗', async () => {
  const fx = await makeFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    dependencies: ['TASK-9'],
    extraCards: [{ id: 'TASK-9', status: '執行完成回報', repo: true }],
    steps: [writes('aaa'), says('減完了'), says('符合要求')],
  })
  await upstreamPassed(fx.repoDir, 'TASK-9')

  const d = new LocalDispatcher(await loadAgents(fx.boardDir), () => {})
  const s = await drain({ boardDir: fx.boardDir, dispatch: d, log: () => {} })
  assert.equal(s.done, 1)
  assert.equal(s.blocked, 0, '通過的上游不該擋住下游')
})

test('依賴停在執行完成回報但沒有成果分支（跑失敗）→ 擋住', async () => {
  // 失敗的卡也停在「執行完成回報」—— 那一欄的意思是「球在你手上」，不是「成功了」。
  // 分辨兩者的機械證據只有成果分支存不存在。
  const fx = await makeFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    dependencies: ['TASK-9'],
    extraCards: [{ id: 'TASK-9', status: '執行完成回報', repo: true }],
    steps: [writes('aaa'), says('減完了'), says('符合要求')],
  })
  // 刻意不建 task/task-9

  const d = new LocalDispatcher(await loadAgents(fx.boardDir), () => {})
  const s = await drain({ boardDir: fx.boardDir, dispatch: d, log: () => {} })
  assert.equal(s.blocked, 1, '失敗的上游不能放行下游')
  assert.equal((await fx.calls()).length, 0)
})

test('上游標了 require_review 就退回舊行為：一定要你驗過', async () => {
  const fx = await makeFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    dependencies: ['TASK-9'],
    extraCards: [
      { id: 'TASK-9', status: '執行完成回報', repo: true, requireReview: true },
    ],
    steps: [writes('aaa'), says('減完了'), says('符合要求')],
  })
  await upstreamPassed(fx.repoDir, 'TASK-9') // 跑完了、也通過了

  const d = new LocalDispatcher(await loadAgents(fx.boardDir), () => {})
  const s = await drain({ boardDir: fx.boardDir, dispatch: d, log: () => {} })
  assert.equal(s.blocked, 1, 'require_review 的地基就是要等人')
  assert.equal((await fx.calls()).length, 0)
})

test('同一次排空裡，上游剛跑完下游就接著跑 —— 整晚跑得下去的關鍵', async () => {
  // 這條是這整組改動的理由。上游在這一輪才進「執行完成回報」，
  // 下游必須在**同一輪**看到它已經好了，而不是等下次排空。
  const fx = await makeFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    extraCards: [
      { id: 'TASK-2', status: '待執行', repo: true, dependencies: ['TASK-1'] },
    ],
    steps: [
      writes('aaa'), says('減完了'), says('符合要求'),   // TASK-1
      writes('aaa'), says('減完了'), says('符合要求'),   // TASK-2
    ],
  })

  const d = new LocalDispatcher(await loadAgents(fx.boardDir), () => {})
  const s = await drain({ boardDir: fx.boardDir, dispatch: d, log: () => {} })
  assert.equal(s.done, 2, '兩張都要在同一輪做完')
  assert.equal(s.blocked, 0)

  // 而且下游要真的從上游的成果長出來，不是從 main
  const merged = await run('git', ['merge-base', '--is-ancestor', 'task/task-1', 'task/task-2'], {
    cwd: fx.repoDir,
  })
  assert.equal(merged.code, 0, '下游的分支必須含有上游的成果')
})

test('依賴還沒產出成果時，這張卡也不送去規劃', async () => {
  // 「依賴」和「子卡」是同一件事的兩種形狀，規則要一致。
  // 實跑撞過：TASK-1.2 依賴 TASK-1.1，兩張同一批送規劃，PM 站在還沒有
  // parse.js 的世界裡，停手回報「src/parse.js 在這個分支不存在」。
  const fx = await makeFixture({
    files: { pattern: 'x' },
    verify: VERIFY,
    status: '規劃中',
    dependencies: ['TASK-9'],
    extraCards: [{ id: 'TASK-9', status: '待執行', repo: true }],
    steps: [says('# Plan\n做吧')],
  })

  const d = new LocalDispatcher(await loadAgents(fx.boardDir), () => {})
  const s = await planAll({ boardDir: fx.boardDir, dispatch: d, log: () => {} })
  assert.equal(s.waiting, 1)
  assert.equal(s.planned, 0)
  assert.equal((await fx.calls()).length, 0, '等上游就不該呼叫 PM')
})

test('子卡跑完通過（還沒人驗）就足以讓父卡進規劃', async () => {
  // 這條跟排空那組同源：規劃階段的擋板也不該預設等人，
  // 否則父卡的 plan 要等你點過三次才產得出來。
  const fx = await makeFixture({
    files: { pattern: 'x' },
    verify: VERIFY,
    status: '規劃中',
    extraCards: [{ id: 'TASK-1.1', status: '執行完成回報', repo: true, parent: 'TASK-1' }],
    steps: [says('# Plan\n把子模組串起來')],
  })
  await run('git', ['branch', '-f', 'task/task-1.1', 'main'], { cwd: fx.repoDir })

  const d = new LocalDispatcher(await loadAgents(fx.boardDir), () => {})
  const s = await planAll({ boardDir: fx.boardDir, dispatch: d, log: () => {} })
  assert.equal(s.waiting, 0)
  assert.equal(s.planned, 1)
})

// ── 規劃時 PM 站在哪 ────────────────────────────────────────────────────
//
// 實跑撞出來的：PM 規劃父卡時 repo 還停在上一張卡留下的 attempt 分支，
// 它看到兩個子模組、看不到第三個，於是停手回報「truncate 不存在」。
// 觀察是對的，錯的是我沒把它放在對的地方。

test('父卡規劃時，PM 看得到所有子卡的成果合在一起', async () => {
  const fx = await makeFixture({
    files: { base: 'x' },
    verify: VERIFY,
    status: '規劃中',
    extraCards: [
      { id: 'TASK-1.1', status: '執行完成回報', repo: true, parent: 'TASK-1' },
      { id: 'TASK-1.2', status: '執行完成回報', repo: true, parent: 'TASK-1' },
    ],
    steps: [says('# Plan\n串起來')],
  })

  // 兩張子卡各自在不同檔案上留下成果
  for (const [id, file] of [['1.1', 'a.js'], ['1.2', 'b.js']] as const) {
    await run('git', ['checkout', '-q', '-B', `task/task-${id}`, 'main'], { cwd: fx.repoDir })
    await writeFile(`${fx.repoDir}/${file}`, 'x', 'utf8')
    await run('git', ['add', '-A'], { cwd: fx.repoDir })
    await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', id], {
      cwd: fx.repoDir,
    })
  }
  // repo 停在一條只看得到 b.js 的分支 —— 這正是實跑時的狀況
  await run('git', ['checkout', '-q', 'task/task-1.2'], { cwd: fx.repoDir })

  const d = new LocalDispatcher(await loadAgents(fx.boardDir), () => {})
  await planAll({ boardDir: fx.boardDir, dispatch: d, log: () => {} })

  const seen = (await fx.calls())[0]?.files ?? []
  assert.ok(seen.includes('a.js'), `PM 要看得到 a.js，實際看到 ${JSON.stringify(seen)}`)
  assert.ok(seen.includes('b.js'), `PM 要看得到 b.js，實際看到 ${JSON.stringify(seen)}`)
})

test('規劃不會改動 repo 的狀態 —— 規劃是唯讀的', async () => {
  const fx = await makeFixture({
    files: { base: 'x' },
    verify: VERIFY,
    status: '規劃中',
    steps: [says('# Plan\n做吧')],
  })
  await run('git', ['checkout', '-q', '-b', '我在這條上工作'], { cwd: fx.repoDir })

  const d = new LocalDispatcher(await loadAgents(fx.boardDir), () => {})
  await planAll({ boardDir: fx.boardDir, dispatch: d, log: () => {} })

  const pm = (await fx.calls())[0]
  // macOS 的 tmpdir 是 symlink，兩邊都要 realpath 才比得準
  assert.notEqual(pm?.cwd, await realpath(fx.repoDir), 'PM 要在 worktree 裡工作，不能站在 repo 上')

  const after = await run('git', ['branch', '--show-current'], { cwd: fx.repoDir })
  assert.equal(after.stdout.trim(), '我在這條上工作', '規劃完 repo 要停在原本的地方')
  const wt = await run('git', ['worktree', 'list'], { cwd: fx.repoDir })
  assert.equal(wt.stdout.trim().split('\n').length, 1, '暫時的 worktree 要拆乾淨')
})

test('父卡有兩張以上子卡時，每一張的成果都要合進來', async () => {
  // 這條是為了釘死一個真的踩過的 bug：用 `merge --no-commit` 迴圈的話，
  // 第一次合併留下未結束的合併狀態，第二個 merge 被 git 拒絕 ——
  // 而且是**悄悄地**失敗，agent 拿到一個看起來正常但少了東西的工作區。
  const fx = await makeFixture({
    files: { pattern: 'aa' },
    verify: VERIFY,
    sections: { 'Acceptance Criteria': '- [ ] #1 整體 → `test/run.js::t0`' },
    extraCards: [
      { id: 'TASK-1.1', status: '完成', parent: 'TASK-1' },
      { id: 'TASK-1.2', status: '完成', parent: 'TASK-1' },
    ],
    steps: [says('整合完了'), says('減完了'), says('符合要求')],
  })

  for (const [id, file] of [['1.1', 'from-a'], ['1.2', 'from-b']] as const) {
    await run('git', ['checkout', '-q', '-B', `task/task-${id}`, 'main'], { cwd: fx.repoDir })
    await writeFile(`${fx.repoDir}/${file}`, 'x', 'utf8')
    await run('git', ['add', '-A'], { cwd: fx.repoDir })
    await run('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', id], {
      cwd: fx.repoDir,
    })
  }
  await run('git', ['checkout', '-q', 'main'], { cwd: fx.repoDir })

  const lines: string[] = []
  const d = new LocalDispatcher(await loadAgents(fx.boardDir), (l) => lines.push(l))
  const s = await drain({ boardDir: fx.boardDir, dispatch: d, log: (l) => lines.push(l) })
  assert.equal(s.done, 1, lines.join('\n'))

  for (const f of ['from-a', 'from-b']) {
    const r = await run('git', ['cat-file', '-e', `task/task-1:${f}`], { cwd: fx.repoDir })
    assert.equal(r.code, 0, `${f} 要在父卡的成果裡`)
  }
})
