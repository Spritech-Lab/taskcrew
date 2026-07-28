#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { defaultAgentFiles, loadAgents } from './agents.ts'
import { BusDispatcher, pingBus, sendCommand } from './bus.ts'
import { LocalDispatcher, type Dispatcher } from './dispatch.ts'
import { planAll } from './plan.ts'
import { countPlanning, drain } from './runner.ts'
import { serve } from './serve.ts'
import { watch } from './watch.ts'
import { runWorker } from './worker.ts'
import type { Role } from './claude.ts'

/**
 * taskcrew CLI。
 *
 * 兩個指令對應看板上兩段「球在 agent 手上」的區間：
 *   plan —— 規劃中 → 設計待批准（PM 產做法，等你審）
 *   run  —— 待執行 → 執行完成回報（產線跑完，等你驗）
 *
 * 中間那一段（設計待批准 → 待執行）是你的，沒有指令 —— 你拖卡就是批准。
 * 觸發刻意是明確指令而非常設排程：卡進了 queue 只是排隊，不會自己開始。
 */

const USAGE = `
taskcrew — 把 Backlog.md 看板變成無人看管的多 agent 開發產線

用法：
  taskcrew init [board]    把 agent 定義寫進 <board>/agents/，之後你自己調
  taskcrew plan [board]    PM 研究 codebase，把「規劃中」的卡產出做法
  taskcrew run  [board]    排空「待執行」欄
  taskcrew agent <role> [board]
                           把一個角色跑成常駐 agent（pm / junior / senior / qa）

  taskcrew serve [board]   常駐服務：等入口層下指令再執行
  taskcrew watch [board]   訂閱產線事件（也是入口層的參考實作）
  taskcrew send <run|plan> [board] [--at <ISO時間>]
                           對常駐服務下指令

  taskcrew <cmd> --dry     只列出會做什麼，不實際執行
  taskcrew <cmd> --bus     走 Redis 派工給常駐 agent（預設是直接 spawn）

  board 預設為當前目錄。

看板流程：
  開卡 → 需求討論 → 規劃中 → 設計待批准 → 待執行 → 執行中 → 執行完成回報 → 完成
                     └ plan ┘              └────────── run ──────────┘

結束條件只有兩個：queue 空了，或撞到訂閱額度。
不設卡數上限、不設時間上限、不設花費上限 —— 一律只吃訂閱額度。
`.trim()

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE)
    return 0
  }
  if (cmd === 'init') {
    const dir = resolve(rest.find((a) => !a.startsWith('-')) ?? process.cwd())
    const agentsDir = join(dir, 'agents')
    await mkdir(agentsDir, { recursive: true })
    for (const f of await defaultAgentFiles()) {
      // 不覆寫 —— 使用者調過的東西不能被 init 洗掉
      const target = join(agentsDir, f.name)
      try {
        await writeFile(target, f.content, { encoding: 'utf8', flag: 'wx' })
        console.log(`  建立 agents/${f.name}`)
      } catch {
        console.log(`  略過 agents/${f.name}（已存在）`)
      }
    }
    console.log('\n改 model 或 effort 就編輯這些檔案的 frontmatter。')
    return 0
  }

  if (cmd === 'agent') {
    const role = rest[0] as Role
    if (!['pm', 'junior', 'senior', 'qa'].includes(role)) {
      console.error('用法：taskcrew agent <pm|junior|senior|qa> [board]')
      return 2
    }
    const boardDir = resolve(rest.slice(1).find((a) => !a.startsWith('-')) ?? process.cwd())
    if (!(await pingBus())) {
      console.error('連不上 Redis —— 常駐 agent 需要它。先確認 redis-server 有在跑。')
      return 4
    }
    const ac = new AbortController()
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.on(sig, () => ac.abort())
    }
    await runWorker({ role, boardDir, signal: ac.signal })
    return 0
  }

  if (cmd === 'serve' || cmd === 'watch') {
    const boardDir = resolve(rest.find((a) => !a.startsWith('-')) ?? process.cwd())
    if (!(await pingBus())) {
      console.error('連不上 Redis —— 這個指令需要它。先確認 redis-server 有在跑。')
      return 4
    }
    const ac = new AbortController()
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => ac.abort())
    if (cmd === 'serve') await serve({ boardDir, signal: ac.signal })
    else {
      console.log(`訂閱 ${boardDir} 的產線事件。Ctrl-C 結束。\n`)
      await watch({ boardDir, signal: ac.signal })
    }
    return 0
  }

  if (cmd === 'send') {
    const what = rest[0]
    if (what !== 'run' && what !== 'plan') {
      console.error('用法：taskcrew send <run|plan> [board] [--at <ISO時間>]')
      return 2
    }
    const atIdx = rest.indexOf('--at')
    const at = atIdx >= 0 ? Date.parse(rest[atIdx + 1] ?? '') : undefined
    if (atIdx >= 0 && Number.isNaN(at)) {
      console.error('--at 的時間看不懂。用 ISO 格式，例如 2026-07-29T02:00')
      return 2
    }
    const boardDir = resolve(
      rest.slice(1).find((a) => !a.startsWith('-') && a !== rest[atIdx + 1]) ?? process.cwd(),
    )
    if (!(await pingBus())) {
      console.error('連不上 Redis。')
      return 4
    }
    await sendCommand(boardDir, { type: what, at })
    console.log(at ? `已排程 ${what}（${new Date(at).toLocaleString()}）` : `已送出 ${what}`)
    return 0
  }

  if (cmd !== 'run' && cmd !== 'plan') {
    console.error(`未知的指令：${cmd}\n`)
    console.error(USAGE)
    return 2
  }

  const dryRun = rest.includes('--dry') || rest.includes('--dry-run')
  const useBus = rest.includes('--bus')
  const boardDir = resolve(rest.find((a) => !a.startsWith('-')) ?? process.cwd())
  console.log(`看板：${boardDir}${dryRun ? '  (dry-run)' : ''}${useBus ? '  (匯流排)' : ''}\n`)

  const dispatch = await makeDispatcher(boardDir, useBus)
  if (!dispatch) return 4

  try {
    return await runCommand(cmd, { boardDir, dryRun, dispatch })
  } finally {
    await dispatch.close()
  }
}

async function makeDispatcher(boardDir: string, useBus: boolean): Promise<Dispatcher | null> {
  const agents = await loadAgents(boardDir)
  const log = (l: string) => console.log(l)
  if (!useBus) return new LocalDispatcher(agents, log)

  if (!(await pingBus())) {
    console.error('連不上 Redis。先啟動它，或拿掉 --bus 改用本機直接執行。')
    return null
  }
  return BusDispatcher.create(boardDir, agents, log)
}

async function runCommand(
  cmd: 'run' | 'plan',
  o: { boardDir: string; dryRun: boolean; dispatch: Dispatcher },
): Promise<number> {
  const { boardDir, dryRun, dispatch } = o

  if (cmd === 'plan') {
    const s = await planAll({ boardDir, dryRun, dispatch })
    console.log('')
    console.log(
      [`已規劃 ${s.planned}`, `未完成 ${s.failed}`, s.costUsd ? `花費 $${s.costUsd.toFixed(2)}` : null]
        .filter(Boolean)
        .join(' · '),
    )
    if (s.stoppedByLimit) return 3
    return s.failed > 0 ? 1 : 0
  }

  const s = await drain({ boardDir, dryRun, dispatch })
  console.log('')
  console.log(
    [
      `完成 ${s.done}`,
      s.proposed ? `待你批准新方案 ${s.proposed}` : null,
      `未通過 ${s.failed}`,
      `阻塞 ${s.blocked}`,
      `沒過閘門 ${s.rejected}`,
      s.costUsd ? `花費 $${s.costUsd.toFixed(2)}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  )

  // 「規劃中」的卡是 run 撿不到的 —— 提醒一下，免得使用者以為卡不見了
  const planning = await countPlanning(boardDir)
  if (planning > 0) {
    console.log(`\n另有 ${planning} 張卡在「規劃中」，跑 \`taskcrew plan\` 讓 PM 產出做法。`)
  }

  if (s.stoppedByLimit) {
    console.log('\n因訂閱額度上限提前停止。下次下指令時會從中斷處接著跑。')
    return 3
  }
  return s.failed > 0 || s.rejected > 0 ? 1 : 0
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  })
