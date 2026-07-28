import { boardNs, connect, KEYS } from './bus.ts'
import { format, type PipelineEvent } from './dispatch.ts'

/**
 * 訂閱產線事件。
 *
 * 這支指令的用途有兩個：一是你在終端機盯著看，二是**當入口層的參考實作** ——
 * 你的 Discord bot 要做的事跟這裡一樣，只是把 `render` 換成發訊息到頻道。
 *
 * taskcrew 刻意不附任何 bot：入口層是你的，核心只負責定義事件契約。
 */

export interface WatchOptions {
  boardDir: string
  /** 拿到的是**結構化事件**，不是字串 —— 你可以自己決定怎麼呈現、要不要過濾 */
  onEvent?: (event: PipelineEvent) => void
  signal?: AbortSignal
}

export async function watch(opts: WatchOptions): Promise<void> {
  const ns = boardNs(opts.boardDir)
  const client = await connect()
  const render = opts.onEvent ?? defaultRender

  await client.subscribe(KEYS.events(ns), (msg) => {
    try {
      render(JSON.parse(msg) as PipelineEvent)
    } catch {
      // 壞掉的訊息不該讓訂閱者死掉 —— 它只是個觀察者
    }
  })

  await new Promise<void>((resolve) => {
    if (opts.signal?.aborted) return resolve()
    opts.signal?.addEventListener('abort', () => resolve(), { once: true })
  })
  await client.quit()
}

function defaultRender(e: PipelineEvent): void {
  const line = format(e)
  if (line) console.log(line)
}

/**
 * 哪些事件值得推播到手機。
 *
 * 這是給入口層的建議，不是強制 —— 但值得有個預設，因為「每個事件都推播」
 * 會讓人關掉通知，而那等於全部都沒推。挑的標準是：**看到它你會想做點什麼**。
 */
export function worthPushing(e: PipelineEvent): boolean {
  switch (e.type) {
    case 'card-done':
    case 'card-failed':
    case 'card-proposed':
    case 'rate-limited':
      return true
    default:
      return false
  }
}
