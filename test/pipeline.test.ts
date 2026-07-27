import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { readCard } from '../src/board.ts'
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
  const summary = await drain({ boardDir: fx.boardDir, log: (l) => lines.push(l) })
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
      says('新的做法：換個方式'), // PM 換方案
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
  assert.match(log, /→ 交回 PM 重新規劃/)

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
    steps: [writes('axx'), writes('axx'), says('這次改用另一種做法')],
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
