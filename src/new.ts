import { appendFile } from 'node:fs/promises'
import { run } from './shell.ts'

/**
 * 建一張卡的骨架。
 *
 * 這支指令存在的理由很單純：**閘門的七項檢查一直只存在於 code 裡**，所以
 * 除了讀過原始碼的人，沒有人建得出能過閘門的卡。骨架把那七項寫出來，
 * 每一段附上「閘門為什麼要它」。
 *
 * 它**不增加任何約束** —— 檢查本來就在，卡不合格現在就過不去。
 *
 * ID 的配發交給 `backlog task create`：階層 ID（TASK-1 → TASK-1.1 → TASK-1.1.1）
 * 和 ordinal 都是 Backlog.md 的邏輯，自己算會跟它分岔。這是 taskcrew 唯一
 * 呼叫 backlog CLI 的地方 —— 其餘一律直接讀寫檔案（CLI 沒有 JSON 輸出，
 * 而且看不到它不認識的區塊）。
 */

export interface NewCardOptions {
  boardDir: string
  title: string
  /** 父卡 ID。模組 → 功能 → 子任務就是靠這個疊出來的，層數不限 */
  parent?: string
  /** 要等哪些卡先產出成果 */
  dependencies?: string[]
  /** 目標 repo；填了就直接寫進 Runner Config，省得你再開檔案 */
  project?: string
}

export async function newCard(o: NewCardOptions): Promise<string> {
  const args = ['task', 'create', o.title]
  if (o.parent) args.push('--parent', o.parent)
  if (o.dependencies?.length) args.push('--dep', o.dependencies.join(','))

  const r = await run('backlog', args, { cwd: o.boardDir })
  if (r.code !== 0) {
    throw new Error(
      `backlog task create 失敗（exit ${r.code}）：${r.stderr.trim() || r.stdout.trim()}\n` +
        '這支指令需要 backlog CLI（brew install backlog-md）。',
    )
  }

  const m = /^File:\s*(.+)$/m.exec(r.stdout)
  if (!m) throw new Error(`看不懂 backlog 的輸出，找不到檔案路徑：\n${r.stdout}`)
  const path = m[1].trim()

  await appendFile(path, skeleton(o.project), 'utf8')
  return path
}

/**
 * 骨架的每一段都附一行說明「閘門為什麼要它」。
 *
 * **所有佔位文字都包在 `⟨⟩` 裡**，而閘門會擋掉還留著 `⟨` 的卡。
 *
 * 這不是裝飾。第一版的佔位文字**自己滿足了閘門檢查** —— 例如
 * 「不要做什麼」那段的說明文字裡就寫著 `**不要做什麼**`，於是一張完全
 * 沒填的卡會被判 pass，然後 agent 拿到「（具體、可驗證的描述）」當需求。
 * 樣板讓閘門變弱了，那比沒有樣板還糟。
 *
 * 寫成註解而不是文件，是因為**你填的時候人在這個檔案裡**，翻文件那一下
 * 就是你不會做的事。填完把說明刪掉或留著都行 —— 閘門只看內容。
 */
function skeleton(project?: string): string {
  return `
## Runner Config

<!-- RUNNER:BEGIN -->
\`\`\`yaml
# project：目標 repo。閘門會檢查它存在、而且是個 git repo
project: ${project ?? '⟨目標 repo 路徑⟩'}
# base_branch：分支從哪長出來。閘門會檢查它在 repo 裡找得到
base_branch: main
# verify：驗收指令。**必須產出逐條結果**（JSON），不能只有 exit code ——
#         跨輪比較逐條結果是分辨「實作沒寫對」和「方案不對」的唯一客觀依據
verify: "⟨吐逐條 JSON 結果的測試指令⟩"
# autonomy：失敗到需要換方案時怎麼辦
#   none      停下來
#   propose   PM 產出新方案寫回卡上，退回「設計待批准」等你看（預設）
#   replan:N  自己換方案並執行，最多 N 次
#   free      換到成功或撞額度
autonomy: propose
\`\`\`
<!-- RUNNER:END -->

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**背景**

⟨為什麼要做這件事⟩

**要做什麼**

⟨具體、可驗證的描述⟩

**不要做什麼**

- ⟨不准碰什麼。無人看管時，擋掉災難最多的就是這一段 ——
   允許清單一定會漏，禁止清單不會⟩
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 ⟨條件⟩ → ⟨\`test/run.js::測試名\`⟩
<!-- AC:END -->

<!--
每一條都要用 → 掛一個對應的測試。閘門會擋掉沒掛的。

理由有兩個：
  1. 寫不出對應測試的條件，就不是驗收條件，是願望
  2. 驗收只看這張卡掛到的測試 —— 同一個 repo 的多張卡共用一條 verify 指令，
     不過濾的話兩張卡會互相擋住，而且會逼 agent 越界去改不屬於它的檔案

測試可以還沒實作（會是紅的），但**測試檔本身要先存在**。
-->

## Implementation Plan

⟨留空。跑 \`taskcrew plan\` 讓 PM 產出，你在「設計待批准」那一欄審。
　審過就把卡拖到「待執行」—— 卡片位置本身就是批准，不需要額外欄位⟩
`
}
