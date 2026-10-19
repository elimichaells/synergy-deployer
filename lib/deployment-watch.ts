export interface DeploymentUpdate {
  id: string
  status: string
  log?: string | null
}

/** Short requests keep logs and completion metadata fresh across proxy disconnects. */
export function watchDeployment<T extends DeploymentUpdate>(id: string, onUpdate: (deployment: T) => void, onError: () => void = () => {}) {
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let request: AbortController | undefined
  let cursor = 0
  let log = ''
  const close = () => {
    closed = true
    if (timer) clearTimeout(timer)
    request?.abort()
  }
  const poll = async () => {
    request = new AbortController()
    const timeout = setTimeout(() => request?.abort(), 10_000)
    let retryMs = 2_000
    try {
      const response = await fetch(`/api/deployments/${encodeURIComponent(id)}?after=${cursor}`, { cache: 'no-store', signal: request.signal })
      if (!response.ok) throw new Error('Could not refresh deployment')
      const deployment = await response.json() as T & { log_chunk?: string; log_next?: number; log_complete?: boolean; log_reset?: boolean }
      if (closed) return
      if (deployment.id !== id || !['running', 'queued', 'success', 'failed'].includes(deployment.status)) throw new Error('Invalid deployment update')
      if (typeof deployment.log_chunk === 'string' && Number.isSafeInteger(deployment.log_next)) {
        if (deployment.log_reset) log = ''
        log += deployment.log_chunk
        cursor = deployment.log_next!
        // Keep rendering bounded; the complete log remains available from the API.
        if (log.length > 500_000) log = '[Earlier output omitted from this view]\n' + log.slice(-450_000)
        deployment.log = log
        if (!deployment.log_complete) retryMs = 100
      }
      onUpdate(deployment)
      if (!['running', 'queued'].includes(deployment.status) && deployment.log_complete !== false) close()
    } catch {
      if (!closed) onError()
      retryMs = 5_000
    } finally {
      clearTimeout(timeout)
      if (!closed) timer = setTimeout(() => void poll(), retryMs)
    }
  }
  void poll()
  return { close }
}
