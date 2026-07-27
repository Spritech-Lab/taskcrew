#!/usr/bin/env node
import { resolve } from 'node:path'
import { planAll } from './plan.ts'
import { countPlanning, drain } from './runner.ts'

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
  taskcrew plan [board]    PM 研究 codebase，把「規劃中」的卡產出做法
  taskcrew run  [board]    排空「待執行」欄
  taskcrew <cmd> --dry     只列出會做什麼，不實際執行

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
  if (cmd !== 'run' && cmd !== 'plan') {
    console.error(`未知的指令：${cmd}\n`)
    console.error(USAGE)
    return 2
  }

  const dryRun = rest.includes('--dry') || rest.includes('--dry-run')
  const boardDir = resolve(rest.find((a) => !a.startsWith('-')) ?? process.cwd())
  console.log(`看板：${boardDir}${dryRun ? '  (dry-run)' : ''}\n`)

  if (cmd === 'plan') {
    const s = await planAll({ boardDir, dryRun })
    console.log('')
    console.log(
      [`已規劃 ${s.planned}`, `未完成 ${s.failed}`, s.costUsd ? `花費 $${s.costUsd.toFixed(2)}` : null]
        .filter(Boolean)
        .join(' · '),
    )
    if (s.stoppedByLimit) return 3
    return s.failed > 0 ? 1 : 0
  }

  const s = await drain({ boardDir, dryRun })
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
