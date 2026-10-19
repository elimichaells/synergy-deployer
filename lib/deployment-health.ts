import { probeHttp } from '../scripts/http-health.cjs'

interface HealthCheckOptions {
  path?: string
  statuses?: number[]
  timeoutMs?: number
  intervalMs?: number
  requestTimeoutMs?: number
  checkProcess?: (timeoutMs: number) => Promise<string | undefined>
  checkCancelled?: () => void
  onProgress?: (message: string) => void | Promise<void>
}

interface HealthCheckDependencies {
  fetch: typeof fetch
  now: () => number
  sleep: (milliseconds: number) => Promise<void>
}

export async function waitForDeploymentHealth(
  port: number,
  options: HealthCheckOptions = {},
  dependencies: HealthCheckDependencies = {
    fetch,
    now: () => performance.now(),
    sleep: (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds)),
  }
): Promise<{ healthy: boolean; reason?: string }> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const deadline = dependencies.now() + timeoutMs
  const remaining = () => Math.max(0, Math.ceil(deadline - dependencies.now()))
  let lastFailure = 'No HTTP response'
  let attempt = 0

  while (remaining() > 0) {
    options.checkCancelled?.()
    if (options.checkProcess) {
      const status = await options.checkProcess(Math.min(5000, remaining()))
      if (status === 'errored' || status === 'stopped' || status === 'missing') {
        return { healthy: false, reason: `Application process is ${status}; check its runtime logs and environment configuration` }
      }
    }
    if (remaining() === 0) break
    options.checkCancelled?.()
    attempt++

    try {
      const response = await probeHttp(`http://127.0.0.1:${port}${options.path || '/'}`, {
        signal: AbortSignal.timeout(Math.min(options.requestTimeoutMs ?? 5000, remaining())),
        statuses: options.statuses,
      }, dependencies.fetch)
      options.checkCancelled?.()
      if (dependencies.now() < deadline && response.ok) {
        return { healthy: true }
      }
      lastFailure = response.reason || `HTTP ${response.status}`
    } catch (error) {
      const cause = error instanceof Error ? error.cause as { code?: string } | undefined : undefined
      lastFailure = cause?.code || (error instanceof Error ? error.message : 'Request failed')
    }

    options.checkCancelled?.()
    await options.onProgress?.(`[health] Attempt ${attempt}: ${lastFailure}; ${Math.ceil(remaining() / 1000)}s remaining\n`)
    if (remaining() > 0) await dependencies.sleep(Math.min(options.intervalMs ?? 2000, remaining()))
  }

  return { healthy: false, reason: `Health check timed out after ${timeoutMs / 1000}s on port ${port}: ${lastFailure}` }
}
