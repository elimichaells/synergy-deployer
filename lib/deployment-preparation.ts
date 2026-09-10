import { randomUUID } from 'crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, stat } from 'fs/promises'
import path from 'path'
import { getProjectTypeDefaults, normalizeProjectType, type ProjectType } from './project-types'

type Append = (message: string) => void | Promise<void>
type CommandResult = { code: number; output: string }

interface ProjectCommands {
  project_type?: ProjectType | null
  install_cmd: string | null
  build_cmd: string | null
  start_cmd: string | null
}

function projectRoot(rootPath: string) {
  if (!path.isAbsolute(rootPath)) throw new Error('The project directory must be an absolute path')
  const root = path.resolve(rootPath)
  if (root === path.parse(root).root) throw new Error('A drive or filesystem root cannot be used as a project directory')
  return root
}

async function entryInfo(filename: string) {
  try { return await lstat(filename) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function prepareProjectParent(rootPath: string) {
  const root = projectRoot(rootPath)
  await mkdir(path.dirname(root), { recursive: true })
  const entry = await entryInfo(root)
  if (entry && !(await stat(root)).isDirectory()) throw new Error(`Project path is not a directory: ${root}`)
}

export async function detectCheckoutProjectType(rootPath: string): Promise<ProjectType | undefined> {
  const root = projectRoot(rootPath)
  const candidates: ProjectType[] = []
  const hasPackage = !!await entryInfo(path.join(root, 'package.json'))
  if (hasPackage) {
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies }
    if (dependencies.next) candidates.push('next')
    if (dependencies['@angular/core'] && await entryInfo(path.join(root, 'angular.json'))) candidates.push('angular')
  }
  if (await entryInfo(path.join(root, 'go.mod'))) candidates.push('go')
  if (await entryInfo(path.join(root, 'artisan')) && await entryInfo(path.join(root, 'composer.json'))) candidates.push('laravel')
  if (candidates.length === 1) return candidates[0]
  return candidates.length === 0 && hasPackage ? 'node' : undefined
}

export function resolveCheckoutCommands(project: ProjectCommands, detected: ProjectType | undefined): ProjectCommands {
  const configured = normalizeProjectType(project.project_type)
  if (!detected || detected === configured) return project
  const defaults = getProjectTypeDefaults(configured)
  const usesDefaultCommands = (project.install_cmd === null || project.install_cmd === defaults.installCmd || (configured === 'next' && project.install_cmd === 'npm install'))
    && (project.build_cmd === null || project.build_cmd === defaults.buildCmd)
    && (project.start_cmd === null || project.start_cmd === defaults.startCmd)
  // New registrations historically defaulted to Next.js before a checkout existed.
  if (configured !== 'next' || !usesDefaultCommands) {
    throw new Error(`Checkout is ${detected}, but the project is configured as ${configured}. Review the project type and custom commands in Settings`)
  }
  const detectedDefaults = getProjectTypeDefaults(detected)
  return {
    project_type: detected,
    install_cmd: null,
    build_cmd: detectedDefaults.buildCmd,
    start_cmd: detected === 'angular' ? null : detectedDefaults.startCmd,
  }
}

export async function prepareProjectCheckout(rootPath: string, projectType: unknown, append: Append) {
  const root = projectRoot(rootPath)
  const type = normalizeProjectType(projectType)
  const manifests = type === 'go' ? ['go.mod'] : type === 'laravel' ? ['composer.json', 'artisan']
    : type === 'angular' ? ['package.json', 'angular.json'] : ['package.json']
  for (const manifest of manifests) {
    if (!(await entryInfo(path.join(root, manifest)))?.isFile()) {
      throw new Error(`${type} project is missing ${manifest} in ${root}. Check the project type and application directory`)
    }
  }
  // Probe actual write access rather than relying on inherited Windows ACL labels.
  const probe = await mkdtemp(path.join(root, '.manager-write-check-'))
  await rmdir(probe)
  await append(`[prepare] ${type} checkout verified; project directory is writable\n`)
  const envFiles = []
  for (const name of ['.env', '.env.local']) {
    if (await entryInfo(path.join(root, name))) envFiles.push(name)
  }
  await append(envFiles.length
    ? `[prepare] Preserving ${envFiles.join(', ')} and repository lockfiles\n`
    : '[prepare] No local .env file; application configuration must come from injected variables or repository defaults\n')
}

export async function defaultInstallCommand(rootPath: string, projectType: unknown) {
  const type = normalizeProjectType(projectType)
  if (['next', 'node', 'angular'].includes(type)) {
    for (const lockfile of ['npm-shrinkwrap.json', 'package-lock.json']) {
      if (await entryInfo(path.join(rootPath, lockfile))) return 'npm ci --include=dev'
    }
    return 'npm install --include=dev'
  }
  return getProjectTypeDefaults(type).installCmd
}

export function localNpmInstall(command: string): 'ci' | 'install' | undefined {
  if (/[;&|<>\r\n"'`]/.test(command)) return undefined
  const tokens = command.trim().split(/\s+/)
  if (!/^npm(?:\.cmd)?$/i.test(tokens[0])) return undefined
  if (!['ci', 'install', 'i'].includes(tokens[1])) return undefined
  const flags = tokens.slice(2)
  if (flags.some(flag => !flag.startsWith('--') || /^--(?:global|prefix|workspace|workspaces|location|package-lock-only)(?:=|$)/i.test(flag))) return undefined
  return tokens[1] === 'ci' ? 'ci' : 'install'
}

export function isDependencyCleanupFailure(output: string, rootPath: string) {
  const normalized = output.replace(/\\/g, '/').toLowerCase()
  const dependencyPath = path.join(projectRoot(rootPath), 'node_modules').replace(/\\/g, '/').toLowerCase()
  return /\b(?:ENOTEMPTY|EPERM|EBUSY)\b/.test(output)
    && /\b(?:rmdir|unlink|rename)\b/i.test(output)
    && normalized.split(dependencyPath).slice(1).some(suffix => !suffix || /^[/'"\r\n]/.test(suffix))
}

function assertDirectChild(root: string, target: string, expectedName: string) {
  if (path.dirname(target) !== root || path.basename(target) !== expectedName) {
    throw new Error('Refusing dependency recovery outside the project directory')
  }
}

async function moveDependenciesAside(rootPath: string, append: Append, checkCancelled: () => void) {
  const root = projectRoot(await realpath(projectRoot(rootPath)))
  const source = path.join(root, 'node_modules')
  assertDirectChild(root, source, 'node_modules')
  const entry = await entryInfo(source)
  if (!entry) return undefined
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Refusing to reset linked or non-directory node_modules; inspect the project dependency path')
  const name = `.manager-node_modules-${randomUUID()}`
  const destination = path.join(root, name)
  assertDirectChild(root, destination, name)
  await append(`[prepare] Moving ${source} to ${destination}\n`)
  for (let attempt = 0; attempt < 4; attempt++) {
    checkCancelled()
    try {
      await rename(source, destination)
      return { root, destination, name }
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '') || attempt === 3) {
        throw new Error('Could not move node_modules aside. Close processes using this project directory, then retry. No source, environment, or lockfiles were removed')
      }
      await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)))
    }
  }
}

export async function runPreparedDeploymentCommand(
  command: string,
  rootPath: string,
  execute: (command: string) => Promise<CommandResult>,
  append: Append,
  checkCancelled: () => void = () => {}
): Promise<CommandResult> {
  const npmInstall = localNpmInstall(command)
  if (!npmInstall) return execute(command)
  const root = projectRoot(rootPath)
  if (!(await entryInfo(path.join(root, 'package.json')))?.isFile()) throw new Error('npm install requires package.json in the project directory')
  if (npmInstall === 'ci' && !await entryInfo(path.join(root, 'package-lock.json')) && !await entryInfo(path.join(root, 'npm-shrinkwrap.json'))) {
    throw new Error('npm ci requires a committed package-lock.json or npm-shrinkwrap.json. Generate and commit the lockfile, or configure npm install')
  }
  checkCancelled()
  const result = await execute(command)
  checkCancelled()
  if (result.code === 0 || !isDependencyCleanupFailure(result.output, root)) return result

  await append('[prepare] npm could not clean node_modules. Preserving the old dependency tree and retrying this install once\n')
  const previous = await moveDependenciesAside(root, append, checkCancelled)
  checkCancelled()
  const retried = await execute(command)
  checkCancelled()
  if (retried.code !== 0) {
    await append(`[prepare] Clean install also failed; no further automatic retries.${previous ? ` Previous dependencies retained at ${previous.destination}` : ''}\n`)
    return retried
  }
  if (previous) {
    try {
      // Recheck containment and the top-level link before recursive cleanup.
      if (await realpath(root) !== previous.root) throw new Error('Project directory changed during installation')
      assertDirectChild(previous.root, previous.destination, previous.name)
      if ((await lstat(previous.destination)).isSymbolicLink()) throw new Error('Dependency backup became a link')
      await rm(previous.destination, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 })
    } catch {
      await append(`[prepare] Install succeeded; old dependencies remain at ${previous.destination} for later cleanup\n`)
    }
  }
  await append('[prepare] Clean dependency installation succeeded\n')
  return retried
}
