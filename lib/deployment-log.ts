/** Batch small process output chunks; persist only newly received text. */
export function createDeploymentLogWriter(write: (chunk: string) => Promise<unknown>, delayMs = 500) {
  let pending = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let writing: Promise<void> | undefined
  let failure: unknown
  let closed = false
  const flush = (): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = undefined }
    if (failure) return Promise.reject(failure)
    return writing ??= (async () => {
      while (pending) {
        const chunk = pending
        pending = ''
        try { await write(chunk) } catch (error) { failure = error; throw error }
      }
    })().finally(() => { writing = undefined })
  }
  return {
    append(chunk: string) {
      if (closed) throw new Error('Deployment log is closed')
      // Recovery must still be able to append diagnostics after a database failure.
      // Explicit flush reports the error; the caller retains a full final log.
      if (failure) return
      pending += chunk
      if (!timer) timer = setTimeout(() => { void flush().catch(() => {}) }, delayMs)
    },
    flush,
    async close() { closed = true; await flush() },
  }
}
