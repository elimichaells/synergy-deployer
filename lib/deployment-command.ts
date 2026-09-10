import { runCommand } from './exec'

export const DEPLOYMENT_COMMAND_TIMEOUT_MS = 15 * 60_000

export async function runDeploymentCommand(
  command: string,
  cwd: string,
  env: Record<string, string>,
  append: (message: string) => void,
  checkCancelled: () => void,
  heartbeatMs = 30_000
) {
  checkCancelled()
  const controller = new AbortController()
  const cancellation = setInterval(() => {
    try {
      checkCancelled()
    } catch {
      controller.abort()
    }
  }, 1000)
  try {
    append(`[command] Time limit: ${DEPLOYMENT_COMMAND_TIMEOUT_MS / 60_000} minutes; cancellation available\n`)
    const result = await runCommand(command, cwd, DEPLOYMENT_COMMAND_TIMEOUT_MS, append, env, false, {
      signal: controller.signal,
      heartbeatMs,
    })
    checkCancelled()
    return result
  } finally {
    clearInterval(cancellation)
  }
}
