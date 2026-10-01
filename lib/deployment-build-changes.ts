import { createHash } from 'crypto'
import { cp, lstat, mkdir, readFile } from 'fs/promises'
import path from 'path'

// A deployment's own install and build can rewrite files that are committed to Git:
// npm install rewrites package-lock.json, and some builds regenerate committed bundles.
// Once that release is live the checkout looks "modified", and without this record the
// next deployment would refuse to run in order to protect edits nobody actually made.

/** Tracked path -> SHA-256 of the content the deployment left behind, or 'deleted'. */
export type BuildChanges = Record<string, string>
type Execute = (command: string) => Promise<{ code: number; output: string }>

const SAFE_PATH = /^[^"\r\n\0]+$/
const TIMESTAMP_SLACK_MS = 2 * 60_000

function safeRelative(value: string) {
  if (!SAFE_PATH.test(value) || value.startsWith('-') || path.isAbsolute(value)) return false
  return !value.replace(/\\/g, '/').split('/').some(part => part === '..' || part === '')
}

/**
 * Splits `git status --porcelain=v1 --untracked-files=no` into plain edits or deletions of
 * tracked files, and anything else (renames, staged additions, conflicts, unusual names).
 * Only plain entries can ever be attributed to a build; the rest always need a person.
 */
export function parseTrackedChanges(output: string) {
  const paths: string[] = []
  const complex: string[] = []
  for (const line of output.split(/\r?\n/)) {
    if (line.length < 4) continue
    const status = line.slice(0, 2)
    const file = line.slice(3)
    if (/^[ MDT]{2}$/.test(status) && status.trim() && !file.startsWith('"') && !file.includes(' -> ') && safeRelative(file)) paths.push(file)
    else complex.push(file.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 160))
  }
  return { paths, complex }
}

/**
 * Decides which changed files are the last deployment's own output.
 * With a record, a file counts only if its content still matches exactly what that deployment left.
 * Without one (the live release predates this record), a file counts only if it was last written
 * while that deployment was running.
 * An npm lockfile that changed while its package.json did not is npm's own output in either case:
 * a person adding a dependency changes package.json too.
 * A file that differs from the commit only in its line endings is never a person's edit; that
 * comes from Git's own conversion on Windows or from a tool rewriting the file.
 */
export function classifyLocalChanges(input: {
  paths: string[]
  hashes: Record<string, string>
  mtimes: Record<string, number | null>
  manifest: BuildChanges | null
  window: { from: number; to: number } | null
  /** Files whose content differs from the commit once line endings are ignored. Omit when unknown. */
  contentChanged?: string[]
}) {
  const generated: string[] = []
  const unexplained: string[] = []
  // True when a file was recognised without an exact content match, so a copy is kept before it is reset.
  let inferred = false
  const changed = new Set(input.paths)
  const realContent = input.contentChanged ? new Set(input.contentChanged) : null
  const lineEndingsOnly = (file: string) => !!realContent && !realContent.has(file) && typeof input.mtimes[file] === 'number'
  const npmOutput = (file: string) => {
    const match = /^(.*\/)?(?:package-lock|npm-shrinkwrap)\.json$/.exec(file.replace(/\\/g, '/'))
    // It must still exist: a deleted lockfile is not something npm install produces.
    return !!match && typeof input.mtimes[file] === 'number' && !changed.has((match[1] || '') + 'package.json')
  }
  for (const file of input.paths) {
    if (input.manifest?.[file] && input.manifest[file] === input.hashes[file]) { generated.push(file); continue }
    const written = input.mtimes[file]
    const duringDeployment = !input.manifest && !!input.window && typeof written === 'number'
      && written >= input.window.from - TIMESTAMP_SLACK_MS && written <= input.window.to + TIMESTAMP_SLACK_MS
    if (duringDeployment || npmOutput(file) || lineEndingsOnly(file)) { generated.push(file); inferred = true } else unexplained.push(file)
  }
  return { generated, unexplained, inferred }
}

export function localChangesMessage(files: string[]) {
  const shown = files.slice(0, 8)
  const remainder = files.length - shown.length
  return `Local source changes detected. Deployment stopped to preserve them. Changed tracked files: ${shown.join(', ')}${remainder ? `, and ${remainder} more` : ''}. Review and commit/push the intended changes before redeploying; Manager will not discard them.`
}

async function fingerprint(root: string, relative: string) {
  const target = path.resolve(root, relative)
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Changed file escapes the application root')
  const info = await lstat(target).catch(() => null)
  if (!info) return { hash: 'deleted', mtime: null }
  if (!info.isFile()) return { hash: 'not-a-file', mtime: null }
  return { hash: createHash('sha256').update(await readFile(target)).digest('hex'), mtime: info.mtimeMs }
}

/** The tracked files that differ from the commit in a checkout, with their current fingerprints. */
export async function inspectLocalChanges(execute: Execute, root: string) {
  const status = await execute('git status --porcelain=v1 --untracked-files=no')
  if (status.code !== 0) throw new Error('Could not check local source changes; deployment stopped without changing the checkout')
  const { paths, complex } = parseTrackedChanges(status.output)
  const hashes: Record<string, string> = {}
  const mtimes: Record<string, number | null> = {}
  for (const file of paths) {
    const result = await fingerprint(root, file)
    hashes[file] = result.hash; mtimes[file] = result.mtime
  }
  // Compared with the commit, ignoring carriage returns at line ends. If this cannot be determined,
  // every changed file is treated as a real content change.
  const content = paths.length ? await execute('git diff HEAD --ignore-cr-at-eol --name-only') : { code: 0, output: '' }
  const contentChanged = content.code === 0 ? content.output.split(/\r?\n/).filter(Boolean) : paths
  return { paths, complex, hashes, mtimes, contentChanged }
}

/** What this deployment's own commands changed in the candidate, recorded for the next deployment. */
export async function recordBuildChanges(execute: Execute, root: string): Promise<BuildChanges> {
  const { paths, hashes } = await inspectLocalChanges(execute, root)
  return Object.fromEntries(paths.filter(file => hashes[file] !== 'not-a-file').map(file => [file, hashes[file]]))
}

/**
 * Puts build-generated files back to the committed version in a release candidate so Git can
 * update it; the build then regenerates them. Never run against the live checkout.
 * When a backup directory is given, the current content is copied there first.
 */
export async function restoreGeneratedFiles(execute: Execute, root: string, files: string[], backupDirectory?: string) {
  if (files.some(file => !safeRelative(file))) throw new Error('Refusing to restore a file with an unsafe name')
  if (backupDirectory) {
    for (const file of files) {
      const source = path.resolve(root, file)
      if (!(await lstat(source).catch(() => null))?.isFile()) continue
      const destination = path.join(backupDirectory, file)
      await mkdir(path.dirname(destination), { recursive: true })
      await cp(source, destination)
    }
  }
  for (let index = 0; index < files.length; index += 40) {
    const batch = files.slice(index, index + 40).map(file => `"${file}"`).join(' ')
    if ((await execute(`git checkout HEAD -- ${batch}`)).code !== 0) throw new Error('Could not reset build-generated files in the release candidate')
  }
}
