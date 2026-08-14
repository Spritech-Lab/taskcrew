export type QaVerdict =
  | { kind: 'pass' }
  /** 做法對，實作有問題 → 留內層 */
  | { kind: 'implementation-bug'; detail: string }
  /** 忠實照 plan 做了，但 plan 本身達不到驗收條件 → 升中層 */
  | { kind: 'plan-inadequate'; detail: string }
  /** QA 沒照格式回答。當成實作問題處理，但要讓人知道 */
  | { kind: 'unparsed'; text: string }

/**
 * 解析 QA 的判定。
 *
 * 模型幾乎一定會加 markdown 修飾（`**符合要求**`、`## 判定` 之類），
 * 所以比對前先把裝飾剝掉。這不是可有可無的寬容 —— 解析失敗會被當成
 * 「QA 沒過」，白白多跑一輪最貴的 senior。錯誤的嚴格比放寬更花錢。
 */
export function parseVerdict(text: string): QaVerdict {
  const lines = text
    .split('\n')
    .map(strip)
    .filter((l) => l.length > 0)

  // **兩端都掃，中間不碰。**
  //
  // 提示裡寫了「第一行必須是判定」，但那是約定，而約定會被忽略：驗收條件一多
  // （12-14 條），模型就會先做逐條分析的表格、判定推到最後面。實跑連續兩張卡
  // 都這樣，每次都害 senior 白跑一輪 Opus xhigh（約 $1），而實作根本沒問題。
  //
  // 模型的習慣不外乎「先講結論」或「先分析再結論」，掃頭尾就都涵蓋了。
  // 中間的解釋文字仍然不掃 —— 那是當初限制只看前幾行的理由，
  // 解釋裡提到「IMPLEMENTATION_BUG 這種情況」會被誤判成判定。
  const head = lines.slice(0, 3)
  const tail = lines.slice(-3)
  for (const line of [...head, ...tail]) {
    const v = verdictOf(line)
    if (v) return v
  }
  return { kind: 'unparsed', text: text.trim() }
}

/** 一行是不是判定。不是就回 null。 */
function verdictOf(line: string): QaVerdict | null {
  if (/^符合要求/.test(line)) return { kind: 'pass' }
  const bug = /^IMPLEMENTATION_BUG[:：]\s*(.*)$/.exec(line)
  if (bug) return { kind: 'implementation-bug', detail: bug[1].trim() || '（未說明）' }
  const inadequate = /^PLAN_INADEQUATE[:：]\s*(.*)$/.exec(line)
  if (inadequate) return { kind: 'plan-inadequate', detail: inadequate[1].trim() || '（未說明）' }
  return null
}

/** 剝掉 markdown 裝飾與清單符號，只留判定本身 */
function strip(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, '') // 標題
    .replace(/^[-*+]\s+/, '') // 清單
    .replace(/^>\s*/, '') // 引言
    // 只剝 * 和反引號。**不剝底線** —— 底線是 IMPLEMENTATION_BUG /
    // PLAN_INADEQUATE 這些關鍵字的一部分，剝掉判定就永遠比對不到。
    .replace(/[*`]/g, '')
    .trim()
}

export function describeVerdict(v: QaVerdict): string {
  switch (v.kind) {
    case 'pass':
      return '符合要求'
    case 'implementation-bug':
      return v.detail
    case 'plan-inadequate':
      return v.detail
    case 'unparsed':
      return `（QA 沒照格式回答）${v.text.slice(0, 120).replace(/\s+/g, ' ')}`
  }
}
