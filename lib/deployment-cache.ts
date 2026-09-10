import { createHash, randomUUID } from 'crypto'
import { createReadStream } from 'fs'
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'fs/promises'
import path from 'path'
import { localNpmInstall } from './deployment-preparation'

type Execute = (command: string) => Promise<{ code: number; output: string }>
type Append = (message: string) => void | Promise<void>
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
// Copying and hashing a large node_modules tree is much slower than npm ci's
// package-cache-backed install on Windows. Keep snapshots for small services,
// where they are useful, and let larger frontends use npm's native cache.
export const MAX_DEPENDENCY_SNAPSHOT_LOCK_BYTES = 256 * 1024

export function cacheEligible(command: string, manifest: Record<string, unknown>, lock: string) {
  if (localNpmInstall(command) !== 'ci' || manifest.workspaces || Buffer.byteLength(lock, 'utf8') > MAX_DEPENDENCY_SNAPSHOT_LOCK_BYTES) return false
  const scripts = manifest.scripts as Record<string, string> | undefined
  if (['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'preprepare', 'postprepare'].some(name => scripts?.[name])) return false
  // Workspace/file dependencies and root lifecycle hooks can depend on source outside the lockfile.
  return !/"(?:link)"\s*:\s*true|"(?:resolved|version)"\s*:\s*"(?:file:|link:|workspace:|git\+|git:)/.test(lock)
    && !/--(?:dry-run|ignore-scripts|package-lock|install-strategy|global-style|legacy-bundling)(?:=|\s|$)/.test(command)
}

export function dependencyCacheKey(inputs: { manifest: string; lock: string; runtime: string; npm: string; settings: string; command: string; environment: Record<string, string> }) {
  return hash(JSON.stringify({ version: 1, ...inputs,
    environment: Object.fromEntries(Object.entries(inputs.environment).sort(([a], [b]) => a.localeCompare(b))) }))
}

export async function dependencyTreeDigest(root: string, checkCancelled = () => {}) {
  const digest = createHash('sha256')
  const base = await realpath(root)
  async function walk(directory: string) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      checkCancelled()
      const filename = path.join(directory, entry.name)
      const relative = path.relative(base, filename).replace(/\\/g, '/')
      digest.update(JSON.stringify(relative))
      if (entry.isSymbolicLink()) {
        const resolved = await realpath(filename)
        if (!resolved.startsWith(base + path.sep)) throw new Error('Dependency cache cannot contain external links')
        digest.update('link:' + await readlink(filename))
      } else if (entry.isDirectory()) {
        digest.update('directory')
        await walk(filename)
      } else if (entry.isFile()) {
        digest.update('file:' + String((await lstat(filename)).mode & 0o777))
        for await (const chunk of createReadStream(filename)) { checkCancelled(); digest.update(chunk) }
      } else throw new Error('Unsupported dependency cache entry')
    }
  }
  await walk(base)
  return digest.digest('hex')
}

async function maybeRead(filename: string) {
  try { return await readFile(filename, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function installWithDependencyCache(options: {
  command: string; root: string; cacheRoot: string; env: Record<string, string>;
  execute: Execute; executeInstall?: Execute; inspect: Execute; append: Append; checkCancelled: () => void;
}) {
  const { command, root, cacheRoot, env, execute, executeInstall = execute, inspect, append, checkCancelled } = options
  if (!path.isAbsolute(cacheRoot) || path.resolve(cacheRoot) === path.parse(cacheRoot).root) throw new Error('Invalid dependency cache directory')
  if ((await lstat(cacheRoot).catch(() => null))?.isSymbolicLink()) throw new Error('Dependency cache directory must not be a link')
  const manifest = await maybeRead(path.join(root, 'package.json'))
  const lock = await maybeRead(path.join(root, 'npm-shrinkwrap.json')) ?? await maybeRead(path.join(root, 'package-lock.json'))
  const installCommand = localNpmInstall(command) ? `${command} --prefer-offline --no-audit --no-fund` : command
  if (!manifest || !lock || !cacheEligible(command, JSON.parse(manifest), lock)) {
    const reason = lock && Buffer.byteLength(lock, 'utf8') > MAX_DEPENDENCY_SNAPSHOT_LOCK_BYTES
      ? 'large dependency tree; using npm ci with the local npm package cache instead of copying node_modules'
      : 'no reusable frozen dependency snapshot for these settings'
    await append(`[dependencies] Clean install; ${reason}\n`)
    return executeInstall(installCommand)
  }
  const runtime = await inspect('node -p "JSON.stringify({version:process.version,abi:process.versions.modules,platform:process.platform,arch:process.arch})"')
  const npm = await inspect('npm --version')
  const config = await inspect('npm config list --json')
  if (runtime.code || npm.code || config.code) throw new Error('Could not verify Node/npm runtime and install settings')
  const settings = JSON.parse(config.output)
  // These are locations, not installation semantics. Never persist config values or environment secrets.
  for (const key of ['prefix', 'local-prefix', 'cache', 'logs-dir', 'user-agent']) delete settings[key]
  const key = dependencyCacheKey({ manifest, lock, runtime: runtime.output.trim(), npm: npm.output.trim(),
    command, settings: JSON.stringify(Object.fromEntries(Object.entries(settings).sort(([a], [b]) => a.localeCompare(b)))), environment: env })
  const entry = path.join(cacheRoot, key)
  const dependencies = path.join(root, 'node_modules')
  const receiptText = await maybeRead(path.join(entry, 'receipt.json'))
  if (receiptText) {
    try {
      const receipt = JSON.parse(receiptText)
      const cached = path.join(entry, 'node_modules')
      if (receipt.key !== key || receipt.digest !== await dependencyTreeDigest(cached, checkCancelled)) throw new Error('Cache integrity mismatch')
      checkCancelled()
      // Candidate-local copy only. Builds never mutate a shared or live dependency tree.
      if (await maybeExists(dependencies)) throw new Error('Candidate dependencies already exist')
      await cp(cached, dependencies, { recursive: true, dereference: false, verbatimSymlinks: true })
      if (receipt.digest !== await dependencyTreeDigest(dependencies, checkCancelled)) throw new Error('Restored dependency tree failed verification')
      await append(`[dependencies] Verified cache hit ${key.slice(0, 12)}; reused frozen dependencies\n`)
      return { code: 0, output: 'Verified dependency cache hit\n' }
    } catch (error) {
      checkCancelled()
      await append('[dependencies] Cache unavailable or failed verification; using a clean installation\n')
      // Keep the invalid entry for inspection, but allow a new verified snapshot to replace it.
      if (await maybeExists(entry)) await rename(entry, path.join(cacheRoot, '.invalid-' + key + '-' + randomUUID()))
      // npm ci cleans only this isolated candidate, never the current release.
    }
  }
  const result = await executeInstall(installCommand)
  if (result.code !== 0) return result
  checkCancelled()
  if (manifest !== await maybeRead(path.join(root, 'package.json')) || lock !== (await maybeRead(path.join(root, 'npm-shrinkwrap.json')) ?? await maybeRead(path.join(root, 'package-lock.json')))) {
    throw new Error('Frozen install changed its dependency inputs')
  }
  await mkdir(cacheRoot, { recursive: true })
  const temporary = path.join(cacheRoot, '.pending-' + randomUUID())
  try {
    await mkdir(temporary)
    const snapshot = path.join(temporary, 'node_modules')
    await cp(dependencies, snapshot, { recursive: true, dereference: false, verbatimSymlinks: true })
    const digest = await dependencyTreeDigest(snapshot, checkCancelled)
    if (digest !== await dependencyTreeDigest(dependencies, checkCancelled)) throw new Error('Dependency snapshot changed while copying')
    await writeFile(path.join(temporary, 'receipt.json'), JSON.stringify({ version: 1, key, digest, createdAt: new Date().toISOString() }))
    if (!await maybeExists(entry)) await rename(temporary, entry)
    await append(`[dependencies] Saved verified snapshot ${key.slice(0, 12)}\n`)
  } catch {
    checkCancelled()
    await append('[dependencies] Snapshot could not be saved; installation succeeded and security audit is still required\n')
  } finally {
    if (path.dirname(temporary) === path.resolve(cacheRoot) && !((await lstat(temporary).catch(() => null))?.isSymbolicLink())) {
      await rm(temporary, { recursive: true, force: true })
    }
  }
  return result
}

async function maybeExists(filename: string) { return !!await lstat(filename).catch(error => {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
  throw error
}) }

/** Keep registry-provided text bounded and on one line in deployment logs. */
export function formatAuditFindings(output: string): string {
  let report
  try { report = JSON.parse(output) } catch { return '' }
  if (!report?.vulnerabilities || typeof report.vulnerabilities !== 'object') return ''
  const line = (value: unknown) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 300) : ''
  const findings = Object.entries(report.vulnerabilities).filter(([, value]) =>
    value && typeof value === 'object' && ['high', 'critical'].includes((value as { severity: string }).severity))
  const lines: string[] = []
  for (const [name, value] of findings.slice(0, 50)) {
    const finding = value as { severity: string; range?: string; via?: unknown[]; fixAvailable?: boolean | { name?: string; version?: string; isSemVerMajor?: boolean } }
    lines.push(`[security] ${line(finding.severity)}: ${line(name)} (affected: ${line(finding.range) || 'see advisory'})`)
    for (const via of (Array.isArray(finding.via) ? finding.via : []).slice(0, 10)) {
      if (typeof via === 'string') {
        lines.push(`[security]   Via dependency: ${line(via)}`)
      } else if (via && typeof via === 'object') {
        const advisory = via as { title?: string; url?: string }
        let url = ''
        try {
          const parsed = new URL(advisory.url || '')
          if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash) url = line(parsed.href)
        } catch { /* A missing or invalid URL must not hide the finding. */ }
        lines.push(`[security]   ${line(advisory.title) || 'Security advisory'}${url ? ' — ' + url : ''}`)
      }
    }
    const fix = finding.fixAvailable
    if (fix && typeof fix === 'object') {
      lines.push(`[security]   npm suggests ${line(fix.name) || line(name)}@${line(fix.version) || 'a patched version'}${fix.isSemVerMajor ? ' (major upgrade; migration and testing required)' : ''}`)
    } else {
      lines.push(fix === true ? '[security]   Compatible update available; update and commit the lockfile.' : '[security]   No automatic fix reported; review the advisory and upstream dependency.')
    }
  }
  if (findings.length > 50) lines.push(`[security] ${findings.length - 50} additional affected packages omitted; run npm audit for the full report.`)
  if (findings.length) lines.push('[security] Reproduce in the candidate: npm audit --package-lock-only --omit=dev --audit-level=high')
  return lines.length ? lines.join('\n') + '\n' : ''
}

export function assertAuditPassed(result: { code: number; output: string }, scope = 'dependencies') {
  let report
  try { report = JSON.parse(result.output) } catch { throw new Error('Security audit returned an invalid report; release blocked') }
  const counts = report?.metadata?.vulnerabilities
  if (report.error || !counts || !['low', 'moderate', 'high', 'critical'].every(level => Number.isInteger(counts[level]) && counts[level] >= 0)) {
    throw new Error('Security audit was unavailable; release blocked')
  }
  if (counts.high || counts.critical || result.code !== 0) {
    throw new Error(`Security gate blocked release: ${counts.high} high and ${counts.critical} critical vulnerabilities in ${scope}. Review npm audit and update dependencies`)
  }
  return counts as Record<string, number>
}
