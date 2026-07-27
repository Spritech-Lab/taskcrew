import { spawn } from 'node:child_process'

export interface Run {
  code: number
  stdout: string
  stderr: string
}

/**
 * 跑一個指令並收集輸出。
 *
 * 刻意用 argv 陣列而非 shell 字串 —— 卡片上的 `project` 路徑是使用者寫的，
 * 走 shell 等於讓卡片內容可以執行任意指令。
 */
export function run(
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timer: NodeJS.Timeout | undefined

    if (opts.timeoutMs) {
      timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
    }

    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (e) => {
      if (timer) clearTimeout(timer)
      resolve({ code: 127, stdout, stderr: stderr + String(e) })
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/**
 * 跑 verify 指令。這個**必須**走 shell —— 卡片上的 verify 是使用者寫的完整
 * 指令列（含管線、旗標），不是 argv。信任邊界在閘門：只有你批准過的卡才會走到這裡。
 */
export function runShell(
  command: string,
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<Run> {
  return run('/bin/sh', ['-c', command], opts)
}

export function git(cwd: string, args: readonly string[]): Promise<Run> {
  return run('git', args, { cwd })
}
