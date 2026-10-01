import { cp, lstat, mkdir, readdir, rm } from 'fs/promises'
import path from 'path'

// Framework build caches that make a rebuild much faster when the previous
// build's cache is present. Next.js keeps Turbopack/webpack and TypeScript state
// in .next/cache; Angular keeps its build cache in .angular/cache.
export const BUILD_CACHE_DIRS = ['.next/cache', '.angular/cache']
// A cache this large is no longer cheap to copy; build from scratch instead.
export const MAX_BUILD_CACHE_BYTES = 3 * 1024 ** 3

type Append = (message: string) => void | Promise<void>

/** Total size of a directory tree, refusing links so a cache can never point outside the app. */
async function treeSize(directory: string, limit: number): Promise<number> {
  let total = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('the cache contains a link')
    if (entry.isDirectory()) total += await treeSize(filename, limit - total)
    else if (entry.isFile()) total += (await lstat(filename)).size
    if (total > limit) return total
  }
  return total
}

/**
 * Gives a release candidate a copy of the current release's build cache, so the
 * build starts warm. Only the candidate is written; the live app is never touched.
 * Returns the cache directories that were seeded, so a failed build can retry without them.
 */
export async function seedBuildCache(liveRoot: string, candidateRoot: string, append: Append, limit = MAX_BUILD_CACHE_BYTES) {
  const seeded: string[] = []
  for (const relative of BUILD_CACHE_DIRS) {
    const from = path.join(liveRoot, relative)
    const to = path.join(candidateRoot, relative)
    const source = await lstat(from).catch(() => null)
    if (!source || !source.isDirectory() || source.isSymbolicLink()) continue
    if (await lstat(to).catch(() => null)) continue
    const started = Date.now()
    try {
      const bytes = await treeSize(from, limit)
      if (bytes > limit) {
        await append(`[build] Not reusing ${relative}: it is larger than ${Math.round(limit / 1024 ** 3)} GB; building from scratch\n`)
        continue
      }
      await mkdir(path.dirname(to), { recursive: true })
      await cp(from, to, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true })
      seeded.push(to)
      await append(`[build] Reusing the build cache from the current release (${relative}, ${Math.round(bytes / 1024 ** 2)} MB, copied in ${((Date.now() - started) / 1000).toFixed(1)}s)\n`)
    } catch (error) {
      await rm(to, { recursive: true, force: true }).catch(() => undefined)
      await append(`[build] Not reusing ${relative} (${(error as Error).message}); building from scratch\n`)
    }
  }
  return seeded
}

/** Removes caches seeded into a candidate, for a clean retry. */
export async function discardSeededCaches(seeded: string[]) {
  for (const directory of seeded) await rm(directory, { recursive: true, force: true })
}
