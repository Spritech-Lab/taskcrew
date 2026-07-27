# taskcrew

把 [Backlog.md](https://github.com/MrLesk/Backlog.md) 看板變成一條無人看管的多 agent 開發產線。

跑在**你自己本機的 Claude Code** 之上，因此吃的是你既有的訂閱額度 —— 不需要 API key，不產生額外帳單。taskcrew 從頭到尾不碰認證。

> **狀態：Phase 2。** 四角產線（PM / junior RD / senior RD / QA）與三層循環已實測可用。
> 常駐服務、Redis queue、Postgres 執行歷史、多入口介面還沒做 —— 見下方 Roadmap。

## 它做什麼

你在看板上把一張卡從「設計待批准」拖到「待執行」，就等於批准了它。之後你下一個指令，
taskcrew 逐張把卡做完：開專用分支、交給 agent 實作、跑你指定的驗收指令、把結果寫回卡片，
然後停在「執行完成回報」等你驗收。

```
開卡 → 需求討論 → 規劃中 → 設計待批准 → 待執行 → 執行中 → 執行完成回報 → 完成
        ↑           ↑          ↑                                      │
        └───────────┴──────────┴─────── 不滿意，拖回來再談一輪 ←───────┘
```

## 三個設計取捨

**入口愈開放愈好，閘門愈嚴愈好。** 誰都可以建卡 —— 對話、Discord bot、web UI、你寫的腳本。
品質不靠限制入口保證，靠卡進「待執行」時的七項檢查。其中最硬的一條：**每條驗收條件都必須
掛到一個可執行的 test case**。寫不出對應測試的條件，就不是驗收條件，是願望。

**「有沒有做到」用機械判定，「做得好不好」才交給判斷力。** 驗收指令必須產出逐條結果，
不能只有 exit code —— 因為跨輪比較逐條結果的變化，是分辨「實作沒寫對」和「方案本身不對」
的唯一客觀依據。

**保護在機制層，不在約定層。** push、碰 main、動 `.env`、重啟線上服務，這些是用
`--disallowed-tools` 封死的，不是在 prompt 裡拜託 agent 不要做。就算 agent 判斷錯誤，
也做不出不可逆的事。

## 安裝

需要 Node ≥ 24（原生執行 TypeScript，沒有 build step）與已登入的 [Claude Code](https://claude.com/claude-code)。

```bash
npm install -g taskcrew
```

## 用法

```bash
taskcrew plan [board]       # PM 研究 codebase，把「規劃中」的卡產出做法
taskcrew run  [board]       # 排空「待執行」欄
taskcrew <cmd> --dry        # 只列出會做什麼，不實際執行
```

兩個指令對應看板上兩段「球在 agent 手上」的區間。中間那段（設計待批准 → 待執行）
是你的 —— 沒有指令，**你拖卡就是批准**。

卡進了 queue **只是排隊，不會自己開始** —— 每次執行都是一次明確授權。

結束條件只有兩個：queue 空了，或撞到訂閱額度。不設卡數、時間、花費上限。

## 卡片要寫什麼

Backlog.md 會在寫入時刪掉它不認識的 frontmatter 欄位，所以 taskcrew 的設定放在**內文區塊**：

````markdown
## Runner Config

<!-- RUNNER:BEGIN -->
```yaml
project: ~/code/my-repo          # 目標 repo
base_branch: main                # 分支從哪長出來
verify: "npm test -- --json"     # 必須產出逐條結果
autonomy: propose                # none | propose | replan:N | free
```
<!-- RUNNER:END -->

## Description

**要做什麼**
…

**不要做什麼**                    ← 必填。無人看管時這段擋掉的災難最多
- …

## Acceptance Criteria

- [ ] 空白轉成連字號 → `test/run.js::spaces-to-dashes`

## Implementation Plan

（做法。這是你在「設計待批准」那一欄審查的對象）
````

## Roadmap

| Phase | 內容 | |
|---|---|---|
| 0 | Backlog.md 前提驗證 | ✅ |
| 1 | 最小鏈路：讀卡 → RD → 驗收 → 寫回 | ✅ |
| 2 | 四角產線與三層循環 | ✅ |
| 3 | 常駐服務、Redis queue、Postgres 執行歷史 | |
| 4 | 入口介面，讓 Discord / Telegram / API 接進來 | |

## License

MIT
