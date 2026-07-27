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

  // 只看前幾行 —— 判定應該在最前面，往後翻太多會撿到解釋文字裡的關鍵字
  for (const line of lines.slice(0, 3)) {
    if (/^符合要求/.test(line)) return { kind: 'pass' }
    const bug = /^IMPLEMENTATION_BUG[:：]\s*(.*)$/.exec(line)
    if (bug) return { kind: 'implementation-bug', detail: bug[1].trim() || '（未說明）' }
    const inadequate = /^PLAN_INADEQUATE[:：]\s*(.*)$/.exec(line)
    if (inadequate) return { kind: 'plan-inadequate', detail: inadequate[1].trim() || '（未說明）' }
  }
  return { kind: 'unparsed', text: text.trim() }
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
