import { lstat, readFile, realpath } from 'fs/promises'
import path from 'path'
import { createHash } from 'crypto'

// Bind review to startup configuration without storing or returning its values.
export async function configurationIdentity(root: string) {
  const actualRoot = await realpath(root)
  const identity: Record<string, string | null> = {}
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local', 'package.json', 'ecosystem.config.js', 'ecosystem.config.cjs', '.next/BUILD_ID']) {
    const file = path.join(actualRoot, name)
    try {
      const info = await lstat(file), actual = await realpath(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 || !actual.toLowerCase().startsWith((actualRoot + path.sep).toLowerCase())) throw Error('Application configuration cannot be verified safely')
      identity[name] = createHash('sha256').update(await readFile(file)).digest('hex')
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') identity[name] = null; else throw error }
  }
  return identity
}
