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
      const response = await fetch(`/api/deployments/${encodeURIComponent(id)}`, { cache: 'no-store', signal: request.signal })
      if (!response.ok) throw new Error('Could not refresh deployment')
      const deployment = await response.json() as T
      if (closed) return
      if (deployment.id !== id || !['running', 'queued', 'success', 'failed'].includes(deployment.status)) throw new Error('Invalid deployment update')
      onUpdate(deployment)
      if (!['running', 'queued'].includes(deployment.status)) close()
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
