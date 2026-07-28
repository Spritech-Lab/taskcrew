import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { loadAgents } from '../src/agents.ts'
import { readCard } from '../src/board.ts'
import { LocalDispatcher } from '../src/dispatch.ts'
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
      says('REPLACE:\n\n新的做法：換個方式'), // PM 判定結構有問題
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
    steps: [writes('axx'), writes('axx'), says('REPLACE:\n\n這次改用另一種做法')],
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

test('未通過就不 commit —— 分支上留著工作區改動，但沒有 commit', async () => {
  const { fx } = await runFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    steps: [writes('axx'), writes('axx')],
  })

  const log = await run('git', ['log', '--oneline', 'task/task-1-attempt-1'], {
    cwd: fx.repoDir,
  })
  assert.equal(log.stdout.trim().split('\n').length, 1, '只該有 init 那一個 commit')

  // 但改動留著，人可以去看它做到哪
  assert.equal((await readFile(`${fx.repoDir}/pattern`, 'utf8')).trim(), 'axx')
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
      says('REPLACE:\n\n結構就錯了，換一個做法'),
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
