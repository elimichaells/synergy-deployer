import { rename } from 'fs/promises'

export async function renameReleasePath(source: string, destination: string, options: {
  rename?: typeof rename
  sleep?: (milliseconds: number) => Promise<void>
  platform?: string
  recoverLock?: () => Promise<void>
} = {}) {
  const move = options.rename || rename
  const sleep = options.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  const windows = (options.platform || process.platform) === 'win32'
  for (let attempt = 0; ; attempt++) {
    try { await move(source, destination); return } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!windows || !['EBUSY', 'EPERM', 'EACCES'].includes(code || '')) throw error
      if (attempt === 5 && options.recoverLock) await options.recoverLock()
      else if (attempt >= 5) {
        throw new Error(`Release directory is still locked or inaccessible after shutdown verification (${code}): ${source}. Check project processes, open terminals and file permissions; files have not been deleted.`, { cause: error })
      }
      await sleep(Math.min(200 * 2 ** attempt, 1000))
    }
  }
}
