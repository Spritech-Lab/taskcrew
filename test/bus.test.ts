import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadAgents } from '../src/agents.ts'
import { readCard } from '../src/board.ts'
import { boardNs, BusDispatcher, connect, KEYS, pingBus } from '../src/bus.ts'
import { drain } from '../src/runner.ts'
import { runWorker } from '../src/worker.ts'
import { makeFixture, verifyScript, type Step } from './helpers/fixture.ts'

/**
 * 匯流排路徑：agent 是常駐訂閱者而非子行程。
 *
 * 這些測試需要 Redis 在跑。沒有的話整組跳過 —— taskcrew 的預設路徑
 * 不需要 Redis，所以缺它不該讓整個測試套件變紅。
 */

const hasRedis = await pingBus()
const VERIFY = verifyScript('./pattern')

const writes = (pattern: string, text = '做完了'): Step => ({ text, cost: 0.01, apply: { pattern } })
const says = (text: string): Step => ({ text, cost: 0.01 })

test('走匯流排時，常駐 agent 完成整條產線', { skip: !hasRedis && '沒有 Redis' }, async () => {
  const fx = await makeFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    steps: [writes('aaa'), says('減完了'), says('符合要求')],
  })

  const agents = await loadAgents(fx.boardDir)
  const ac = new AbortController()
  const lines: string[] = []

  // 四個角色各起一個常駐 worker（用假的 claude，不花錢）
  const workers = (['pm', 'junior', 'senior', 'qa'] as const).map((role) =>
    runWorker({ role, boardDir: fx.boardDir, signal: ac.signal, log: () => {} }),
  )

  const dispatch = await BusDispatcher.create(fx.boardDir, agents, (l) => lines.push(l), 60)
  try {
    const summary = await drain({ boardDir: fx.boardDir, dispatch, log: (l) => lines.push(l) })
    assert.equal(summary.done, 1, lines.join('\n'))
    assert.equal((await readCard(fx.cardPath)).status, '執行完成回報')

    // 角色路由要跟本機路徑一致 —— 換傳輸方式不該換掉編制
    const calls = await fx.calls()
    assert.deepEqual(
      calls.map((c) => c.model),
      ['sonnet', 'opus', 'haiku'],
    )
  } finally {
    ac.abort()
    await dispatch.close()
    await Promise.all(workers)
  }
})

test('事件會發到匯流排，入口層訂閱得到', { skip: !hasRedis && '沒有 Redis' }, async () => {
  const fx = await makeFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    steps: [writes('aaa'), says('減完了'), says('符合要求')],
  })

  // 模擬入口層：訂閱事件頻道
  const sub = await connect()
  const received: { type: string }[] = []
  await sub.subscribe(KEYS.events(boardNs(fx.boardDir)), (msg) => received.push(JSON.parse(msg)))

  const agents = await loadAgents(fx.boardDir)
  const ac = new AbortController()
  const workers = (['pm', 'junior', 'senior', 'qa'] as const).map((role) =>
    runWorker({ role, boardDir: fx.boardDir, signal: ac.signal, log: () => {} }),
  )
  const dispatch = await BusDispatcher.create(fx.boardDir, agents, () => {}, 60)

  try {
    await drain({ boardDir: fx.boardDir, dispatch, log: () => {} })
    await new Promise((r) => setTimeout(r, 200)) // 讓 pub/sub 送達

    const types = received.map((e) => e.type)
    // 這幾個是入口層要用來顯示進度的骨幹
    for (const expected of ['queue-start', 'card-start', 'round-start', 'verify', 'card-done']) {
      assert.ok(types.includes(expected), `缺少事件 ${expected}；收到：${types.join(', ')}`)
    }

    // 事件是結構化的，不是字串 —— 訂閱端才能自己決定怎麼呈現
    const done = received.find((e) => e.type === 'card-done') as { costUsd: number }
    assert.equal(typeof done.costUsd, 'number')
  } finally {
    ac.abort()
    await sub.quit()
    await dispatch.close()
    await Promise.all(workers)
  }
})

test('沒有 agent 在跑時逾時，而且訊息說得清楚', { skip: !hasRedis && '沒有 Redis' }, async () => {
  const fx = await makeFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    steps: [],
  })
  const agents = await loadAgents(fx.boardDir)
  // 逾時設 1 秒，且刻意不起任何 worker
  const dispatch = await BusDispatcher.create(fx.boardDir, agents, () => {}, 1)
  try {
    const r = await dispatch.invoke('junior', '做點事', fx.repoDir)
    assert.equal(r.ok, false)
    assert.match(r.raw, /逾時/)
    assert.match(r.raw, /沒在跑|死了/, '訊息要告訴人下一步該查什麼')
  } finally {
    await dispatch.close()
  }
})

test('過期的派工不會被執行 —— 免得中斷的工作隔天自己跑起來', { skip: !hasRedis && '沒有 Redis' }, async () => {
  const fx = await makeFixture({ files: { pattern: 'xxx' }, verify: VERIFY, steps: [says('不該被執行')] })
  const client = await connect()

  // 模擬「coordinator 已放棄」的殘留派工：截止時間在過去
  await client.rPush(
    KEYS.request(boardNs(fx.boardDir), 'junior'),
    JSON.stringify({ id: 'stale-01', prompt: 'x', cwd: fx.repoDir, deadline: Date.now() - 1000 }),
  )

  const ac = new AbortController()
  const lines: string[] = []
  const worker = runWorker({
    role: 'junior',
    boardDir: fx.boardDir,
    signal: ac.signal,
    log: (l) => lines.push(l),
  })

  await new Promise((r) => setTimeout(r, 1500))
  ac.abort()
  await worker
  await client.quit()

  assert.match(lines.join('\n'), /略過過期的派工/)
  assert.equal((await fx.calls()).length, 0, '過期的派工不該真的呼叫 agent')
})

test('兩個 board 的 agent 不會互相搶工作 —— 這是 firewall，不是整潔問題', { skip: !hasRedis && '沒有 Redis' }, async () => {
  const a = await makeFixture({
    files: { pattern: 'xxx' },
    verify: VERIFY,
    steps: [writes('aaa'), says('減完了'), says('符合要求')],
  })
  // 第二個 board 的 worker 全程待命，但不該碰到 A 的任何派工
  const b = await makeFixture({ files: { pattern: 'xxx' }, verify: VERIFY, steps: [] })

  const ac = new AbortController()
  const bLines: string[] = []
  const bWorkers = (['pm', 'junior', 'senior', 'qa'] as const).map((role) =>
    runWorker({ role, boardDir: b.boardDir, signal: ac.signal, log: (l) => bLines.push(l) }),
  )
  const aWorkers = (['pm', 'junior', 'senior', 'qa'] as const).map((role) =>
    runWorker({ role, boardDir: a.boardDir, signal: ac.signal, log: () => {} }),
  )

  const dispatch = await BusDispatcher.create(a.boardDir, await loadAgents(a.boardDir), () => {}, 60)
  try {
    const summary = await drain({ boardDir: a.boardDir, dispatch, log: () => {} })
    assert.equal(summary.done, 1, 'A 的卡要自己完成')
    assert.doesNotMatch(bLines.join('\n'), /接到派工/, 'B 的 agent 不該接到任何派工')
    assert.notEqual(boardNs(a.boardDir), boardNs(b.boardDir))
  } finally {
    ac.abort()
    await dispatch.close()
    await Promise.all([...aWorkers, ...bWorkers])
  }
})
