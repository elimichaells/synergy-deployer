import { existsSync } from 'fs'
import { runCommand } from '@/lib/exec'

export type RuntimeId = 'git' | 'node' | 'go' | 'angular' | 'php' | 'composer' | 'postgresql'

interface RuntimeDefinition {
  id: RuntimeId
  name: string
  purpose: string
  command: string
  versionCommand: string
  installCommand: string | null
  candidates?: string[]
}

const definitions: RuntimeDefinition[] = [
  { id: 'git', name: 'Git', purpose: 'Repository checkout and deployment', command: 'git', versionCommand: 'git --version', installCommand: 'choco install git -y --no-progress' },
  { id: 'node', name: 'Node.js', purpose: 'Next.js, Angular, and Node applications', command: 'node', versionCommand: 'node --version', installCommand: 'choco install nodejs-lts -y --no-progress' },
  { id: 'go', name: 'Go', purpose: 'Compile and run Go services', command: 'go', versionCommand: 'go version', installCommand: 'choco install golang -y --no-progress', candidates: ['C:\\Program Files\\Go\\bin\\go.exe'] },
  { id: 'angular', name: 'Angular CLI', purpose: 'Angular workspace tooling (project-local CLI remains preferred)', command: 'ng', versionCommand: 'ng version', installCommand: 'cmd /c npm.cmd install -g @angular/cli', candidates: [process.env.APPDATA ? `${process.env.APPDATA}\\npm\\ng.cmd` : ''] },
  { id: 'php', name: 'PHP', purpose: 'Laravel and PHP applications', command: 'php', versionCommand: 'php --version', installCommand: 'choco install php -y --no-progress' },
  { id: 'composer', name: 'Composer', purpose: 'PHP dependency management', command: 'composer', versionCommand: 'composer --version', installCommand: 'choco install composer -y --no-progress' },
  { id: 'postgresql', name: 'PostgreSQL tools', purpose: 'psql, pg_dump, and pg_restore', command: 'psql', versionCommand: 'psql --version', installCommand: null, candidates: ['C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe'] },
]

const installs = ((globalThis as unknown as { __runtimeInstalls?: Set<string> }).__runtimeInstalls ??= new Set<string>())

function executable(definition: RuntimeDefinition) {
  const candidate = definition.candidates?.find((item) => item && existsSync(item))
  return candidate ? `"${candidate}"` : definition.command
}

export async function listRuntimes() {
  return Promise.all(definitions.map(async (definition) => {
    const result = await runCommand(`${executable(definition)} --version`, undefined, 15_000)
    const versionResult = result.code === 0
      ? result
      : await runCommand(definition.versionCommand, undefined, 15_000)
    return {
      id: definition.id,
      name: definition.name,
      purpose: definition.purpose,
      installed: versionResult.code === 0,
      version: versionResult.code === 0 ? versionResult.output.trim().split(/\r?\n/)[0].slice(0, 160) : null,
      canInstall: !!definition.installCommand,
      installing: installs.has(definition.id),
    }
  }))
}

export async function installRuntime(id: string) {
  const definition = definitions.find((item) => item.id === id)
  if (!definition) throw new Error('Unsupported runtime')
  if (!definition.installCommand) throw new Error(`${definition.name} is managed by the PostgreSQL server installer`)
  if (installs.has(id)) throw new Error(`${definition.name} installation is already running`)
  installs.add(id)
  try {
    const result = await runCommand(definition.installCommand, undefined, 15 * 60_000)
    if (result.code !== 0) throw new Error(result.output.slice(-4000) || `${definition.name} installation failed`)
    return { runtime: definition.name, output: result.output.slice(-12_000) }
  } finally {
    installs.delete(id)
  }
}
