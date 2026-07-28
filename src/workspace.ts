import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { satisfiesDownstream, children } from './gate.ts'
import { acceptedBranch } from './pipeline.ts'
import { git } from './shell.ts'
import type { Card } from './types.ts'

/**
 * 一張卡該站在哪裡工作。
 *
 * PM 規劃和 RD 執行**必須看到同一個世界** —— PM 依據 A 寫 plan、RD 站在 B 執行，
 * 那份 plan 就是憑空寫的。實跑撞過：PM 規劃父卡時 repo 還停在上一張卡留下的
 * attempt 分支，它看到兩個子模組、看不到第三個，於是停手回報「truncate 不存在」。
 * 它的觀察正確，錯的是我沒把它放在對的地方。
 */

/**
 * 這張卡的分支該從哪裡長出來。
 *
 * 有依賴就從**最後一個依賴的成果**長出來 —— 依賴的意思就是「我需要它做完的東西」，
 * 從 base_branch 長出來的話那些東西根本不存在，plan 裡寫的「呼叫 A 新加的函式」
 * 會直接找不到。多個依賴時取最後一個：它們是鏈狀的（A→B→C），
 * 最後一個已經含有前面所有人的成果。
 *
 * 沒有依賴（含所有父卡）就用卡上寫的 base_branch。
 */
export async function baseRefFor(
  card: Card,
  all: readonly Card[],
  repo: string,
  onMissing?: (ref: string, fallback: string) => void,
): Promise<string> {
  const fallback = card.runner!.base_branch
  const ready: string[] = []
  for (const id of card.dependencies) {
    const dep = all.find((c) => c.id === id)
    if (dep && (await satisfiesDownstream(dep))) ready.push(id)
  }
  const last = ready[ready.length - 1]
  if (!last) return fallback

  // 「完成」不保證有成果分支 —— 看板是人可以編輯的，你隨時可能手動把一張卡
  // 拖到完成而它從沒真的跑過。那時候從 base_branch 長出來是唯一合理的選擇，
  // 但要說出來：卡片的 plan 可能假設了不存在的東西。
  const ref = acceptedBranch(last)
  if (await refExists(ref, repo)) return ref
  onMissing?.(ref, fallback)
  return fallback
}

/** 父卡開工前要合進來的子卡成果。手動標記完成的子卡沒有分支可合，過濾掉。 */
export async function mergeRefsFor(
  card: Card,
  all: readonly Card[],
  repo: string,
): Promise<string[]> {
  const out: string[] = []
  for (const child of children(card, all)) {
    const ref = acceptedBranch(child.id)
    if (await refExists(ref, repo)) out.push(ref)
  }
  return out
}

export async function refExists(ref: string, repo: string): Promise<boolean> {
  return (await git(repo, ['rev-parse', '--verify', '--quiet', ref])).code === 0
}

/**
 * 開一個暫時的 worktree，把該合的都合進去，讓唯讀的工作在裡面進行。
 *
 * 用 worktree 而不是直接 checkout：**規劃是唯讀的**，沒有理由為了讀而改變
 * repo 的狀態。直接 checkout 的話規劃完 repo 會停在某個分支，那只是把
 * 「現在停在哪」的問題往後推一格。
 *
 * 合併衝突不視為錯誤 —— 對規劃父卡的 PM 來說，衝突正是它要規劃的東西。
 * 讓它看到衝突的工作區，比給它一個假裝沒事的乾淨狀態誠實。
 */
export async function withWorktree<T>(
  repo: string,
  baseRef: string,
  mergeRefs: readonly string[],
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'tc-wt-'))
  // --detach：不佔用分支名，所以同一條分支在別處被簽出也不衝突
  const add = await git(repo, ['worktree', 'add', '--detach', '--quiet', dir, baseRef])
  if (add.code !== 0) {
    await rm(dir, { recursive: true, force: true })
    throw new Error(`無法在 ${baseRef} 開 worktree：${add.stderr.trim()}`)
  }

  try {
    await mergeAll(dir, mergeRefs)
    return await fn(dir)
  } finally {
    await git(repo, ['worktree', 'remove', dir, '--force'])
    await git(repo, ['worktree', 'prune'])
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * 依序把子卡的成果合進當前工作區。
 *
 * **每一次合併都要 commit**，這不是風格選擇：`--no-commit` 會留下未結束的
 * 合併狀態，下一個 `git merge` 會被 git 直接拒絕。父卡有兩張以上子卡時，
 * 不 commit 的寫法只會合進第一張，而且悄悄地 —— 後面幾張的失敗被吞掉，
 * agent 拿到一個看起來正常但少了東西的工作區。（實跑撞到過。）
 *
 * 遇到衝突就停在那裡，把衝突留給 agent —— 解衝突本來就是整合工作的內容，
 * 不是意外。回傳第一個衝突的 ref，讓呼叫端可以說出來。
 */
export async function mergeAll(
  dir: string,
  refs: readonly string[],
): Promise<{ conflicted: string | null }> {
  for (const ref of refs) {
    const m = await git(dir, [
      '-c',
      'user.name=taskcrew',
      '-c',
      'user.email=noreply@localhost',
      'merge',
      '--no-ff',
      '--no-edit',
      ref,
    ])
    if (m.code !== 0) return { conflicted: ref }
  }
  return { conflicted: null }
}

/**
 * 一張卡做完之後，把 repo 收回乾淨的起點。
 *
 * 兩件事，第二件是真正的理由：
 *
 * 1. repo 不該停在某張卡的 attempt 分支上 —— 下一個動作（下一張卡的規劃、
 *    你自己進去看一眼）都會莫名其妙地站在別人的工作上。
 *
 * 2. **沒 commit 的殘骸會被帶走。** `git checkout -B 新分支 base` 在工作區
 *    有未提交變更時會把那些變更**一起帶過去** —— 於是一張失敗的卡的殘骸
 *    會出現在下一張卡的分支上，而且沒有任何跡象。
 *
 * 所以殘骸要先 commit 在它自己的分支上。這也符合「失敗的分支全部保留」：
 * 方案 A 的殘骸在方案 B 也失敗時是關鍵線索，丟掉它等於丟掉你判斷
 * 「要不要繼續放手」的依據。
 */
export async function settle(repo: string, baseBranch: string): Promise<boolean> {
  const dirty = (await git(repo, ['status', '--porcelain'])).stdout.trim().length > 0
  if (dirty) {
    await git(repo, ['add', '-A'])
    await git(repo, [
      '-c',
      'user.name=taskcrew',
      '-c',
      'user.email=noreply@localhost',
      'commit',
      '-m',
      '未完成的殘骸（留作線索）',
    ])
  }
  await git(repo, ['checkout', '--quiet', baseBranch])
  return dirty
}
