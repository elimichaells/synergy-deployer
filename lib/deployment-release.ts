import { cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rmdir, symlink, unlink } from 'fs/promises'
import path from 'path'
import { createHash } from 'crypto'
import { renameReleasePath as rename } from './deployment-filesystem'

const artifacts = new Set(['node_modules', 'vendor', '.next', '.next.backup', 'dist', '.angular', '.turbo', 'app.exe'])
const defaults = ['uploads', 'storage', 'public/uploads', 'public/storage', '.env', '.env.local', '.env.production', '.env.production.local']
type Execute = (command: string, cwd: string) => Promise<{ code: number; output: string }>
type ContentMove = { path: string; from: 'root' | 'candidate'; to: 'previous' | 'root'; state: 'planned' | 'pending' | 'done' | 'reverted' }
const exists = async (filename: string) => !!await lstat(filename).catch(error => {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
  throw error
})

export function retainedPaths(paths: string[]) {
  const valid = paths.map(value => value.replace(/\\/g, '/').replace(/\/$/, '')).filter(Boolean)
  for (const value of valid) {
    if (path.isAbsolute(value) || value.split('/').some(part => !part || part === '..' || part === '.') || value.includes(':')) {
      throw new Error('Invalid persistent application path')
    }
  }
  return [...new Set(valid)].filter(value => !artifacts.has(value.split('/')[0]) && !value.startsWith('.manager-') && !value.startsWith('.git'))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .filter((value, index, all) => !all.slice(0, index).some(parent => value.startsWith(parent + '/')))
}

export async function sourceFingerprint(root: string, execute: Execute) {
  if (!await exists(path.join(root, '.git'))) return ''
  const result = await execute('git ls-files -z', root)
  if (result.code) throw new Error('Could not fingerprint the current source checkout')
  const digest = createHash('sha256')
  const head = await execute('git rev-parse HEAD', root)
  if (head.code) throw new Error('Could not read the current release commit')
  digest.update(head.output.trim())
  for (const file of result.output.split('\0').filter(Boolean).sort()) {
    const target = path.resolve(root, file)
    if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Source file escapes application root')
    digest.update(file)
    digest.update(await readFile(target))
  }
  return digest.digest('hex')
}

export class DeploymentRelease {
  readonly base: string
  readonly candidate: string
  readonly previous: string
  readonly cache: string
  private persistent: string[] = []
  private moved: string[] = []
  private originalMoved = false
  private candidateMoved = false
  private phase = 'building'
  private laravel = false
  readonly activationMode: 'directory' | 'contents'
  private contentMoves: ContentMove[] = []
  private createdLiveDirectories: string[] = []

  private generatedPath(value: string) {
    return artifacts.has(value.split('/')[0]) || (this.laravel &&
      (value === 'public/build' || value.startsWith('public/build/') || value === 'bootstrap/cache' ||
        (value.startsWith('bootstrap/cache/') && value !== 'bootstrap/cache/.gitignore')))
  }

  constructor(readonly root: string, readonly projectId: string, readonly deploymentId: string, options: { activationMode?: 'directory' | 'contents' } = {}) {
    if (!path.isAbsolute(root) || path.resolve(root) === path.parse(path.resolve(root)).root) throw new Error('Invalid application root')
    if (![projectId, deploymentId].every(id => /^[a-zA-Z0-9-]+$/.test(id))) throw new Error('Invalid release identifier')
    this.root = path.resolve(root)
    this.activationMode = options.activationMode || (process.platform === 'win32' ? 'contents' : 'directory')
    const projectBase = path.join(path.dirname(this.root), '.manager-releases', projectId)
    this.base = path.join(projectBase, deploymentId)
    this.candidate = path.join(this.base, 'candidate')
    this.previous = path.join(this.base, 'previous')
    this.cache = path.join(projectBase, 'dependencies')
  }

  private async journal() {
    const temporary = path.join(this.base, 'release.json.tmp')
    const file = await open(temporary, 'w')
    try {
      await file.writeFile(JSON.stringify({ version: 2, projectId: this.projectId,
      deploymentId: this.deploymentId, root: this.root, candidate: this.candidate, previous: this.previous,
      phase: this.phase, persistent: this.persistent, moved: this.moved,
      originalMoved: this.originalMoved, candidateMoved: this.candidateMoved, activationMode: this.activationMode,
        contentMoves: this.contentMoves, createdLiveDirectories: this.createdLiveDirectories }, null, 2))
      await file.sync()
    } finally { await file.close() }
    await rename(temporary, path.join(this.base, 'release.json'))
  }

  private async planContentMoves() {
    const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
    // Only existing persistent paths are retained. A brand-new storage/upload
    // directory supplied by the candidate still needs to be installed.
    const retained: string[] = []
    for (const value of this.persistent) if (await exists(path.join(this.root, value))) retained.push(key(value))
    const plan: ContentMove[] = []
    const visit = async (relative: string): Promise<void> => {
      const normalized = key(relative)
      if (retained.some(value => normalized === value || normalized.startsWith(value + '/'))) return
      const live = path.join(this.root, relative)
      const incoming = path.join(this.candidate, relative)
      const liveInfo = await lstat(live).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      const incomingInfo = await lstat(incoming).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      if (!relative || retained.some(value => value.startsWith(normalized + '/'))) {
        for (const info of [liveInfo, incomingInfo]) {
          if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Persistent data ancestor must be an ordinary directory: ' + relative)
        }
        const entries = new Map<string, string>()
        for (const directory of [liveInfo ? live : undefined, incomingInfo ? incoming : undefined]) {
          if (directory) for (const name of await readdir(directory)) entries.set(key(name), name)
        }
        for (const name of [...entries.values()].sort()) await visit(relative ? relative + '/' + name : name)
      } else {
        if (liveInfo) plan.push({ path: relative, from: 'root', to: 'previous', state: 'planned' })
        if (incomingInfo) plan.push({ path: relative, from: 'candidate', to: 'root', state: 'planned' })
      }
    }
    await visit('')
    return plan
  }

  private async ensureLiveDirectory(relative: string): Promise<void> {
    const directory = path.join(this.root, relative)
    if (await exists(directory)) {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Activation directory must not be a file or link')
      return
    }
    if (relative) {
      const parent = path.dirname(relative)
      await this.ensureLiveDirectory(parent === '.' ? '' : parent)
    }
    // Record intent before creation, just as moves are recorded before rename.
    this.createdLiveDirectories.push(relative)
    await this.journal()
    await mkdir(directory)
  }

  private async activateContents() {
    if (await exists(this.previous)) throw new Error('Previous release destination already exists; refusing to overwrite it')
    this.contentMoves = await this.planContentMoves()
    await this.journal()
    await mkdir(this.previous)
    for (const move of this.contentMoves) {
      const source = path.join(this[move.from], move.path)
      const destination = path.join(this[move.to], move.path)
      if (await exists(destination)) throw new Error('Activation destination already exists: ' + move.path)
      if (move.to === 'root') {
        const parent = path.dirname(move.path)
        await this.ensureLiveDirectory(parent === '.' ? '' : parent)
      } else await mkdir(path.dirname(destination), { recursive: true })
      move.state = 'pending'
      await this.journal()
      await rename(source, destination)
      move.state = 'done'
      await this.journal()
    }
    await this.rebaseGeneratedLinks(this.candidate, this.root)
  }

  private async rollbackContents() {
    for (const move of [...this.contentMoves].reverse()) {
      if (move.state !== 'done') continue
      const source = path.join(this[move.to], move.path)
      const destination = path.join(this[move.from], move.path)
      if (await exists(destination)) throw new Error('Rollback destination already exists; refusing to overwrite: ' + move.path)
      await mkdir(path.dirname(destination), { recursive: true })
      await rename(source, destination)
      move.state = 'reverted'
      await this.journal()
    }
    await this.rebaseGeneratedLinks(this.root, this.candidate)
    for (const relative of [...this.createdLiveDirectories].reverse()) {
      // Never recursively remove live paths. Unexpected new data stays in place.
      await rmdir(path.join(this.root, relative)).catch(error => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error
      })
      this.createdLiveDirectories = this.createdLiveDirectories.filter(value => value !== relative)
      await this.journal()
    }
  }

  private async rebaseGeneratedLinks(previousRoot: string, currentRoot: string) {
    const linksRoot = path.join(currentRoot, '.next', 'node_modules')
    if (!await exists(linksRoot)) return
    const previous = path.resolve(previousRoot)
    const current = path.resolve(currentRoot)
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name)
        const info = await lstat(filename)
        if (info.isSymbolicLink()) {
          const target = await readlink(filename)
          const absoluteTarget = path.resolve(path.dirname(filename), target)
          const relativeTarget = path.relative(previous, absoluteTarget)
          if (!relativeTarget || path.isAbsolute(relativeTarget) || relativeTarget === '..' || relativeTarget.startsWith('..' + path.sep)) continue
          const replacement = path.join(current, relativeTarget)
          const replacementInfo = await lstat(replacement).catch(() => undefined)
          if (!replacementInfo || replacementInfo.isSymbolicLink()) throw new Error('Generated build link target is missing after release relocation')
          await unlink(filename)
          await symlink(replacement, filename, replacementInfo.isDirectory() ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file')
          continue
        }
        if (info.isDirectory()) await visit(filename)
      }
    }
    await visit(linksRoot)
  }

  async prepare(execute: Execute) {
    if (await exists(this.base)) throw new Error('Release workspace already exists; inspect its journal before retrying')
    const projectBase = path.dirname(this.base)
    await mkdir(projectBase, { recursive: true })
    for (const directory of [path.dirname(projectBase), projectBase]) {
      if ((await lstat(directory)).isSymbolicLink()) throw new Error('Private release directories must not be links')
    }
    for (const entry of await readdir(projectBase, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'dependencies') continue
      const filename = path.join(projectBase, entry.name, 'release.json')
      if (!await exists(filename)) continue
      const previous = JSON.parse(await readFile(filename, 'utf8'))
      if (['activating', 'restoring'].includes(previous.phase)) throw new Error('An interrupted release activation needs recovery. Inspect ' + filename)
    }
    await mkdir(this.base)
    // Windows candidates contain private environment files. Secure the newly-created,
    // empty release directory so inherited ACLs protect everything copied into it.
    // Reapplying ACLs to projectBase traverses every retained dependency tree and can
    // take many minutes for Node/Angular applications.
    if (process.platform === 'win32') {
      const secured = await execute(`icacls "${this.base}" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"`, path.dirname(this.root))
      if (secured.code) throw new Error('Could not protect the private release workspace')
    }
    if (await exists(this.root)) {
      this.laravel = await exists(path.join(this.root, 'artisan'))
      if ((await lstat(this.root)).isSymbolicLink()) throw new Error('Linked application roots require explicit migration before isolated deployment')
      if (!await exists(path.join(this.root, '.git'))) throw new Error('Existing application directory is not a Git checkout; prepare it before deployment')
      if (!(await lstat(path.join(this.root, '.git'))).isDirectory()) throw new Error('Git worktrees require an independent deployment checkout')
      const local = await execute('git ls-files --others --exclude-standard --directory -z', this.root)
      const ignored = await execute('git ls-files --others --ignored --exclude-standard --directory -z', this.root)
      const tracked = await execute('git ls-files -z', this.root)
      if (local.code || ignored.code || tracked.code) throw new Error('Could not inspect application-local files')
      const trackedFiles = tracked.output.split('\0').filter(Boolean)
      if (trackedFiles.some(file => artifacts.has(file.split('/')[0]))) throw new Error('Build outputs or dependencies are Git-tracked; remove them from source control before isolated deployment')
      this.persistent = retainedPaths([...defaults, ...local.output.split('\0'), ...ignored.output.split('\0')])
        .filter(value => !this.generatedPath(value))
      // Copy source and private settings, but not dependencies, build output, or mutable runtime data.
      await cp(this.root, this.candidate, { recursive: true, dereference: false, verbatimSymlinks: true,
        filter: source => {
          const relative = path.relative(this.root, source).replace(/\\/g, '/')
          if (!relative) return true
          if (artifacts.has(relative.split('/')[0]) || relative.startsWith('.manager-')) return false
          if (trackedFiles.some(file => file === relative || file.startsWith(relative + '/'))) return true
          if (this.generatedPath(relative) && relative !== 'bootstrap/cache') return false
          return !this.persistent.some(value => !value.startsWith('.env') && (relative === value || relative.startsWith(value + '/')))
        } })
      // Untracked source/configuration may be required by custom builds; retain ordinary files.
      for (const value of this.persistent) {
        const original = path.join(this.root, value)
        if (await exists(original) && (await lstat(original)).isFile()) {
          const destination = path.join(this.candidate, value)
          await mkdir(path.dirname(destination), { recursive: true })
          await cp(original, destination)
        }
      }
      for (const name of ['storage/framework/cache/data', 'storage/framework/sessions', 'storage/framework/views', 'storage/logs']) {
        if (await exists(path.join(this.root, 'artisan'))) await mkdir(path.join(this.candidate, name), { recursive: true })
      }
    }
    await this.journal()
  }

  async activate(recoverRootLock?: () => Promise<void>) {
    if (!await exists(this.candidate)) throw new Error('Release candidate does not exist')
    const parent = await realpath(path.dirname(this.root))
    if (!((await realpath(this.base)).startsWith(parent + path.sep))) throw new Error('Release workspace escaped its application volume')
    // Preflight every data path before stopping/moving any directory.
    for (const value of this.persistent) {
      const destination = path.join(this.candidate, value)
      let ancestor = path.dirname(destination)
      while (ancestor !== this.candidate) {
        if (await exists(ancestor) && (await lstat(ancestor)).isSymbolicLink()) throw new Error('Persistent data destination contains a link')
        ancestor = path.dirname(ancestor)
      }
    }
    this.phase = 'activating'
    await this.journal()
    if (this.activationMode === 'contents') {
      await this.activateContents()
      return
    }
    if (await exists(this.root)) {
      if (await exists(this.previous)) throw new Error('Previous release destination already exists; refusing to overwrite it')
      await rename(this.root, this.previous, { recoverLock: recoverRootLock })
      this.originalMoved = true
      await this.journal()
      for (const value of this.persistent) {
        const original = path.join(this.previous, value)
        if (!await exists(original)) continue
        const destination = path.join(this.candidate, value)
        if (await exists(destination)) {
          const generated = path.join(this.base, 'candidate-local', value)
          await mkdir(path.dirname(generated), { recursive: true })
          await rename(destination, generated)
        }
        await mkdir(path.dirname(destination), { recursive: true })
        await rename(original, destination)
        this.moved.push(value)
        await this.journal()
      }
    }
    await rename(this.candidate, this.root)
    this.candidateMoved = true
    // Next.js creates absolute junctions for external server packages under
    // .next/node_modules. Repoint only links that referenced this candidate;
    // otherwise the verified build breaks as soon as its directory is moved.
    await this.rebaseGeneratedLinks(this.candidate, this.root)
    await this.journal()
  }

  async rollback() {
    this.phase = 'restoring'
    await this.journal()
    if (this.activationMode === 'contents') {
      await this.rollbackContents()
      this.phase = 'rolled-back'
      await this.journal()
      return
    }
    const current = this.candidateMoved ? this.root : this.candidate
    for (const value of [...this.moved].reverse()) {
      const source = path.join(current, value)
      const destination = path.join(this.previous, value)
      await mkdir(path.dirname(destination), { recursive: true })
      await rename(source, destination)
      this.moved = this.moved.filter(item => item !== value)
      await this.journal()
    }
    if (this.candidateMoved) {
      await rename(this.root, this.candidate)
      this.candidateMoved = false
      await this.rebaseGeneratedLinks(this.root, this.candidate)
    }
    if (this.originalMoved) { await rename(this.previous, this.root); this.originalMoved = false }
    this.phase = 'rolled-back'
    await this.journal()
  }

  async complete() { this.phase = 'complete'; await this.journal() }
}
