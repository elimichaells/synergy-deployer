import { lstat, readdir, readFile, realpath, rmdir, unlink } from 'node:fs/promises'
import path from 'node:path'

export const RETENTION = { successfulCopies: 3, releaseDays: 7, failedDays: 3, cacheDays: 7 } as const
const DAY = 86400000
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
const resolved = (value: string) => key(path.resolve(value))
const same = (a: string, b: string) => resolved(a) === resolved(b)
const inside = (parent: string, child: string) => resolved(child).startsWith(resolved(parent) + path.sep)
const info = (file: string) => lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error })

export interface ReleaseApp { id: string; name: string; root_path: string; active_deployment_id: string | null }
export interface RetainedDeployment { id: string; status: string; phase: string; finished_at: string | Date | null; release_path: string | null }
export interface RetentionEntry { path: string; name: string; kind: 'release' | 'cache'; bytes: number; eligible: boolean; reason: string }
export interface RetentionPlan { projectId: string; projectName: string; root: string; entries: RetentionEntry[]; warnings: string[] }
type Journal = { version: number; projectId: string; deploymentId: string; root: string; candidate: string; previous: string; phase: string; activationMode?: string; originalMoved?: boolean; candidateMoved?: boolean; moved?: unknown[]; contentMoves?: { state: string }[] }

/** Every existing ancestor must be ordinary; a linked application parent is not a cleanup boundary. */
export async function ordinaryPath(directory: string) {
  const target = path.resolve(directory)
  let cursor = target
  while (true) {
    const metadata = await lstat(cursor)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw Error('Directory contains a link or is not an ordinary directory')
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  const canonical = await realpath(target)
  if (!same(canonical, target)) {
    // Windows may expand an ordinary 8.3 spelling (ADMINI~1) without traversing a link.
    const [original, actual] = await Promise.all([lstat(target), lstat(canonical)])
    if (!original.ino || original.ino !== actual.ino || original.dev !== actual.dev) throw Error('Directory resolved outside its expected location')
  }
}

/** Links are counted but never followed. Bounded batches avoid slow serial Windows stat calls. */
export async function treeBytes(directory: string, check = () => {}) {
  let bytes = 0
  async function visit(current: string) {
    check()
    const stat = await lstat(current)
    if (stat.isSymbolicLink()) return
    if (!stat.isDirectory()) { bytes += stat.size; return }
    const children = await readdir(current, { withFileTypes: true })
    for (let i = 0; i < children.length; i += 32) {
      check()
      const batch = children.slice(i, i + 32)
      const sizes = await Promise.all(batch.filter(e => !e.isDirectory() && !e.isSymbolicLink()).map(async e => {
        const s = await lstat(path.join(current, e.name)); return s.isFile() ? s.size : 0
      }))
      bytes += sizes.reduce((a, b) => a + b, 0)
    }
    for (const child of children) if (child.isDirectory() && !child.isSymbolicLink()) await visit(path.join(current, child.name))
  }
  await visit(directory)
  return bytes
}

function referenced(directory: string, references: string[]) {
  const needle = key(path.resolve(directory)).replace(/\\/g, '/')
  return references.some(value => key(value).replace(/\\/g, '/').includes(needle))
}

function safeTerminal(journal: Journal, deployment: RetainedDeployment) {
  if (deployment.status === 'success') return journal.phase === 'complete'
  if (!['failed', 'cancelled'].includes(deployment.status)) return false
  if (!Array.isArray(journal.moved) || !Array.isArray(journal.contentMoves)) return false
  if (journal.phase === 'building') return journal.originalMoved === false && journal.candidateMoved === false && !journal.moved.length && !journal.contentMoves.length
  if (journal.phase !== 'rolled-back') return false
  return journal.activationMode === 'contents'
    ? journal.contentMoves.every(move => move.state === 'reverted' || move.state === 'planned')
    : journal.originalMoved === false && journal.candidateMoved === false && !journal.moved.length
}

export async function planReleaseRetention(app: ReleaseApp, deployments: RetainedDeployment[], references: string[], now = Date.now(), check = () => {}, measure = true): Promise<RetentionPlan> {
  if (!uuid.test(app.id) || !path.isAbsolute(app.root_path) || same(app.root_path, path.parse(app.root_path).root) || app.root_path.replace(/\\/g, '/').split('/').some(part => part.toLowerCase() === '.manager-releases')) throw Error('Invalid application cleanup boundary')
  const root = path.join(path.dirname(path.resolve(app.root_path)), '.manager-releases', app.id)
  const plan: RetentionPlan = { projectId: app.id, projectName: app.name, root, entries: [], warnings: [] }
  if (!await info(root)) return plan
  await ordinaryPath(root)
  if (references.some(p => path.isAbsolute(p) && (same(root, p) || inside(root, p)))) {
    // Individual runtime paths are checked per entry; an app configured as the release root blocks it all.
    if (references.some(p => path.isAbsolute(p) && same(root, p))) { plan.warnings.push('Release directory is referenced by an application or process'); return plan }
  }
  const children = await readdir(root, { withFileTypes: true })
  const present = new Set(children.filter(d => d.isDirectory() && !d.isSymbolicLink()).map(d => d.name))
  const successful = new Set(deployments.filter(d => d.status === 'success' && d.finished_at && present.has(d.id)).sort((a, b) => +new Date(b.finished_at!) - +new Date(a.finished_at!)).slice(0, RETENTION.successfulCopies).map(d => d.id))
  if (children.length > 2000) throw Error('Too many release entries; manual storage review is required')
  const journals = new Map<string, Journal>()
  for (const child of children) {
    if (!uuid.test(child.name) || !child.isDirectory() || child.isSymbolicLink()) continue
    try {
      const file = path.join(root, child.name, 'release.json')
      const metadata = await lstat(file)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 8 * 1024 * 1024) continue
      const journal = JSON.parse(await readFile(file, 'utf8')) as Journal
      journals.set(child.name, journal)
      if (['activating', 'restoring'].includes(journal.phase)) { plan.warnings.push('Interrupted activation or recovery requires review; this application is protected'); return plan }
    } catch { /* Unknown or damaged journals are kept. */ }
  }
  for (const child of children) {
    check()
    if (child.name === 'dependencies') continue
    const directory = path.join(root, child.name)
    const entry: RetentionEntry = { path: directory, name: child.name, kind: 'release', bytes: 0, eligible: false, reason: 'Unknown release entry; kept for review' }
    plan.entries.push(entry)
    if (!uuid.test(child.name) || !child.isDirectory() || child.isSymbolicLink()) continue
    const journal = journals.get(child.name)
    const deployment = deployments.find(d => d.id === child.name)
    const pinned = await info(path.join(directory, '.keep'))
    if (pinned) entry.reason = 'Pinned with .keep'
    else if (child.name === app.active_deployment_id) entry.reason = 'Current deployment and its rollback copy'
    else if (referenced(directory, references)) entry.reason = 'Referenced by an application, process or scheduled job'
    else if (!journal || journal.version !== 2 || journal.projectId !== app.id || journal.deploymentId !== child.name ||
      typeof journal.root !== 'string' || !same(journal.root, app.root_path) || typeof journal.candidate !== 'string' || !same(journal.candidate, path.join(directory, 'candidate')) ||
      typeof journal.previous !== 'string' || !same(journal.previous, path.join(directory, 'previous')) || !deployment?.release_path || !same(deployment.release_path, directory)) entry.reason = 'Missing or mismatched release record; kept for review'
    else if (!safeTerminal(journal, deployment)) entry.reason = 'Release or recovery state needs review'
    else if (successful.has(child.name)) entry.reason = 'One of the latest three successful deployments'
    else {
      const cutoff = (deployment.status === 'success' ? RETENTION.releaseDays : RETENTION.failedDays) * DAY
      const finished = deployment.finished_at ? +new Date(deployment.finished_at) : NaN
      if (!Number.isFinite(finished) || now - finished < cutoff) entry.reason = `Kept for ${cutoff / DAY} days after completion`
      else { entry.eligible = true; entry.reason = deployment.status === 'success' ? 'Expired previous release' : 'Expired failed build workspace' }
    }
    if (measure) entry.bytes = await treeBytes(directory, check)
  }
  const caches = path.join(root, 'dependencies')
  if (await info(caches)) {
    await ordinaryPath(caches)
    const list = await readdir(caches, { withFileTypes: true })
    if (list.length > 2000) throw Error('Too many dependency cache entries')
    const candidates = await Promise.all(list.map(async child => ({ child, stat: await lstat(path.join(caches, child.name)) })))
    const newest = candidates.filter(v => /^[a-f0-9]{64}$/.test(v.child.name) && v.stat.isDirectory() && !v.stat.isSymbolicLink()).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0]?.child.name
    for (const { child, stat } of candidates) {
      check()
      const directory = path.join(caches, child.name)
      const validName = /^[a-f0-9]{64}$/.test(child.name) || /^\.invalid-[a-f0-9]{64}-[a-f0-9-]{36}$/.test(child.name) || /^\.pending-[a-f0-9-]{36}$/.test(child.name)
      const entry: RetentionEntry = { path: directory, name: child.name, kind: 'cache', bytes: 0, eligible: false, reason: 'Unknown dependency entry; kept for review' }
      plan.entries.push(entry)
      if (!validName || !stat.isDirectory() || stat.isSymbolicLink()) continue
      if (await info(path.join(directory, '.keep'))) entry.reason = 'Pinned with .keep'
      else if (referenced(directory, references)) entry.reason = 'Referenced by an application, process or scheduled job'
      else if (child.name === newest) entry.reason = 'Most recent dependency snapshot'
      else if (now - stat.mtimeMs < RETENTION.cacheDays * DAY) entry.reason = 'Recent dependency cache'
      else { entry.eligible = true; entry.reason = 'Expired regenerable dependency cache' }
      if (measure) entry.bytes = await treeBytes(directory, check)
    }
  }
  return plan
}

/** Remove only a revalidated entry. Never recursively rm or traverse a junction/symlink. */
export async function removeRetentionEntry(plan: RetentionPlan, entry: RetentionEntry, check = () => {}) {
  if (!entry.eligible || !inside(plan.root, entry.path) || ![plan.root, path.join(plan.root, 'dependencies')].some(p => same(p, path.dirname(entry.path)))) throw Error('Invalid cleanup target')
  await ordinaryPath(entry.path)
  const boundary = path.resolve(entry.path)
  let removedBytes = 0
  async function remove(current: string): Promise<void> {
    check()
    if (!same(current, boundary) && !inside(boundary, current)) throw Error('Cleanup escaped its verified boundary')
    await ordinaryPath(path.dirname(current))
    const stat = await lstat(current)
    if (stat.isSymbolicLink() || stat.isFile()) { await unlink(current); if (stat.isFile()) removedBytes += stat.size; return }
    if (!stat.isDirectory()) throw Error('Unsupported filesystem entry; cleanup stopped')
    // Keep the journal until all other entries are gone, so interrupted cleanup can be reviewed/retried.
    const names = (await readdir(current)).filter(name => name !== 'release.json')
    const assertUnchanged = async () => {
      check()
      await ordinaryPath(current)
      const fresh = await lstat(current)
      if (!fresh.isDirectory() || fresh.isSymbolicLink() || fresh.ino !== stat.ino || fresh.dev !== stat.dev) throw Error('Cleanup directory changed during removal')
    }
    for (let i = 0; i < names.length; i += 16) {
      await assertUnchanged()
      const batch = await Promise.all(names.slice(i, i + 16).map(async name => ({ file: path.join(current, name), stat: await lstat(path.join(current, name)) })))
      for (const item of batch) if (item.stat.isDirectory() && !item.stat.isSymbolicLink()) await remove(item.file)
      await assertUnchanged()
      // Wait for every started unlink even if one fails; never release the app lock with pending deletes.
      const deleted = await Promise.allSettled(batch.filter(item => !item.stat.isDirectory() || item.stat.isSymbolicLink()).map(async item => {
        check()
        if (!item.stat.isFile() && !item.stat.isSymbolicLink()) throw Error('Unsupported filesystem entry; cleanup stopped')
        await unlink(item.file); if (item.stat.isFile()) removedBytes += item.stat.size
      }))
      const failed = deleted.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    }
    await assertUnchanged()
    const journal = path.join(current, 'release.json')
    if (await info(journal)) await remove(journal)
    await assertUnchanged()
    await rmdir(current)
  }
  try { await remove(boundary) } catch (error) { throw Object.assign(error as Error, { removedBytes }) }
  return removedBytes
}
