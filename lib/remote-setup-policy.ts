import type { SetupCheck } from './project-setup-policy'

export const REMOTE_SETUP_CAPABILITY = 'guided-setup-v1'
export const REMOTE_FRAMEWORKS = ['next', 'angular', 'go', 'laravel', 'node'] as const
export type RemoteFramework = typeof REMOTE_FRAMEWORKS[number]
export type RemoteInspection = {
  framework: RemoteFramework | null
  commit: string
  commands: { install_cmd: string; build_cmd: string; start_cmd: string }
  tools: Record<string, string | null>
  packageManager: 'npm' | 'pnpm' | 'yarn' | null
}

export function remoteEnvironmentPlan(mode: unknown, branch: string, stagingBranch: string) {
  if (!['production', 'staging', 'production-staging'].includes(String(mode))) throw new Error('Choose production only, staging only, or both environments')
  return mode === 'production-staging' ? [{ environment: 'production' as const, branch }, { environment: 'staging' as const, branch: stagingBranch }] : [{ environment: mode as 'production' | 'staging', branch }]
}

export function cleanInspection(value: unknown): RemoteInspection {
  const result = value as RemoteInspection
  if (!result || !/^[a-f0-9]{40,64}$/.test(result.commit) || (result.framework !== null && !REMOTE_FRAMEWORKS.includes(result.framework))) throw new Error('Invalid repository inspection')
  const commands = Object.fromEntries(['install_cmd', 'build_cmd', 'start_cmd'].map(key => {
    const command = result.commands?.[key as keyof RemoteInspection['commands']]
    if (typeof command !== 'string' || command.length > 4000 || command.includes('\0')) throw new Error('Invalid detected command')
    return [key, command]
  })) as RemoteInspection['commands']
  const tools = Object.fromEntries(['node', 'git', 'pm2', 'caddy', 'npm', 'pnpm', 'yarn', 'go', 'php', 'composer', 'psql', 'mysql', 'mariadb'].map(key => [key, typeof result.tools?.[key] === 'string' ? result.tools[key]!.replace(/[\x00-\x1f]/g, '').slice(0, 200) : null]))
  return { framework: result.framework, commit: result.commit, commands, tools, packageManager: ['npm', 'pnpm', 'yarn'].includes(String(result.packageManager)) ? result.packageManager : null }
}

export function remoteSetupChecks(app: { inspection?: RemoteInspection | null; project_type?: string | null; setup_decisions?: Record<string, unknown>; database_config?: { status?: string } | null; hostname: string; start_cmd: string; env_names: string[] }): SetupCheck[] {
  const decisions = app.setup_decisions || {}
  const checked = (id: string, step: SetupCheck['step'], label: string, pass: boolean, detail: string): SetupCheck => ({ id, step, label, status: pass ? 'pass' : 'fail', detail })
  const tools = app.inspection?.tools || {}
  const runtime = app.project_type === 'go' ? !!tools.go : app.project_type === 'laravel' ? !!tools.php && !!tools.composer : !!tools.node
  const manager = app.inspection?.packageManager
  return [
    checked('repository', 'repository', 'Repository inspected on this server', !!app.inspection, app.inspection?.commit?.slice(0, 12) || 'Clone and inspect the selected branch.'),
    checked('runtime', 'runtime', 'Framework and prerequisites', REMOTE_FRAMEWORKS.includes(app.project_type as RemoteFramework) && runtime && !!tools.git && !!tools.caddy && !!tools.pm2 && (!manager || !!tools[manager]) && !!app.start_cmd, 'Required tools must be installed for the agent account. Custom commands may need additional tools.'),
    checked('database', 'database', 'Database decision', decisions.database === 'none' || (decisions.database === 'configured' && app.database_config?.status === 'ready'), decisions.database === 'none' ? 'No database required.' : 'The app credential must pass a database query from the target server.'),
    checked('environment', 'environment', 'Environment reviewed', decisions.environment === 'reviewed', `${app.env_names.length} application variable${app.env_names.length === 1 ? '' : 's'}; database credentials are injected separately.`),
    checked('domain', 'domain', 'Address configured', decisions.domain === 'configured' && !app.hostname.endsWith('.invalid'), 'Each environment needs its own hostname. DNS and client certificate trust are managed by your institution.'),
  ]
}
