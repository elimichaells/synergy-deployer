import { NextResponse } from 'next/server'
import { dataServiceRemovalReason, migrationRemovalReason } from '@/lib/data-removal-policy'

// Synthetic preview API. Never copied into the production application.
const initialProject = { id: 'fixture-app', name: 'Payments API', slug: 'payments-api', repo_url: 'https://github.com/example/payments-api', default_branch: 'staging', project_type: 'go', root_path: 'C:\\web\\production\\payments-api', pm2_name: 'payments-api', port: 3117, url: null, auto_deploy: false, runtime_versions: {}, install_cmd: null, build_cmd: null, start_cmd: null, deploy_script: null, environment: 'production', is_active: true, github_connection_id: 'github-one', github_connection_name: 'Engineering', github_account_login: 'example', setup_required: true, step: 'repository', decisions: {}, completed_at: null }
const state = (globalThis as unknown as { __workspaceFixture?: { project: Record<string, any>; checkout: boolean; env: string; domains: any[]; services: any[]; failure: string; role: string; grouped: boolean } }).__workspaceFixture ??= { project: { ...initialProject }, checkout: false, env: '', domains: [], services: [], failure: '', role: 'admin', grouped: true }
export const dynamic = 'force-dynamic'
const result = (data: unknown, status = 200) => NextResponse.json(data, { status })
const settingsDefaults = { PRODUCTION_PATH: 'C:\\web\\production', STAGING_PATH: 'C:\\web\\staging', LOGS_PATH: 'C:\\web\\logs', CADDY_PATH: 'C:\\web', NOTIFY_WEBHOOK_URL: 'https://example.test/notifications', BACKUP_DIR: 'C:\\web\\backups\\postgres', BACKUP_ENABLED: 'false', BACKUP_RETENTION_DAYS: '14', PG_BIN_PATH: 'C:\\Program Files\\PostgreSQL\\18\\bin' }
const settingsState = (globalThis as unknown as { __settingsFixture?: { values: Record<string, string>; writes: Record<string, string>[]; notifications: number } }).__settingsFixture ??= { values: { ...settingsDefaults }, writes: [], notifications: 0 }
const dataState = (globalThis as unknown as { __dataFixture?: { enabled: boolean; services: any[]; migrations: any[]; deleted: string[] } }).__dataFixture ??= { enabled: false, services: [], migrations: [], deleted: [] }
const listedServices = () => dataState.services.map(service => ({ ...service, removal_blocked_reason: dataServiceRemovalReason({ ...service, migration_count: dataState.migrations.filter(job => job.source_service_id === service.id || job.target_service_id === service.id).length, migration_active: dataState.migrations.some(job => (job.source_service_id === service.id || job.target_service_id === service.id) && ['queued', 'running', 'validating'].includes(job.status)) }) }))
const fixtureRuntimes = () => ['git', 'node', 'go', 'php', 'composer', 'angular', 'postgresql', 'mysql', 'mariadb', 'caddy', 'sling', 'phpmyadmin'].map(id => ({ id, name: ({ node: 'Node.js', go: 'Go', php: 'PHP', mysql: 'MySQL', postgresql: 'PostgreSQL tools', phpmyadmin: 'phpMyAdmin', angular: 'Angular CLI', caddy: 'Caddy', git: 'Git', composer: 'Composer', mariadb: 'MariaDB', sling: 'Sling migration engine' } as Record<string, string>)[id], purpose: 'Application host dependency', installed: !['mariadb', 'angular'].includes(id), version: ['mariadb', 'angular'].includes(id) ? null : id === 'node' ? 'v24.13.0' : '1.0.0', installedVersions: ['node', 'php', 'go'].includes(id) ? ['1.0.0', '2.0.0'] : [], canInstall: true, canUpdate: true, canConfigure: id === 'mysql', versioned: ['node', 'php', 'go'].includes(id), updateAvailable: id === 'node', latestVersion: id === 'node' ? '24.14.0' : null, updateRisk: 'minor', activeJob: null, latestJob: null }))
export async function GET(request: Request) {
  const url = new URL(request.url); const pathname = url.pathname
  if (pathname === '/api/auth/me') return result({ user: { id: 'fixture-user', name: 'Alex Morgan', email: 'alex@example.test', role: state.role } })
  if (pathname === '/api/settings') return state.failure === 'settings-load' ? result({ error: 'Fixture settings service unavailable' }, 503) : result({ ...settingsState.values, GITHUB_TOKEN: 'fixture-legacy-secret' })
  if (pathname === '/api/__fixture/settings') return result(settingsState)
  if (pathname === '/api/__fixture/data') return result(dataState)
  if (pathname === '/api/data/services') return result({ services: listedServices() })
  if (pathname === '/api/data/migrations') return result({ migrations: dataState.migrations.map(job => ({ ...job, removal_blocked_reason: migrationRemovalReason(job.status) })) })
  if (pathname === '/api/data/backups/schedules') return result({ schedules: [] })
  if (pathname === '/api/users') return state.role !== 'admin' ? result({ error: 'Forbidden' }, 403) : result([{ id: 'fixture-user', name: 'Alex Morgan', email: 'alex@example.test', role: 'admin', status: 'active' }, { id: 'fixture-operator', name: 'Jordan Smith', email: 'jordan@example.test', role: 'operator', status: 'active' }, { id: 'fixture-viewer', name: 'Sam Lee', email: 'sam@example.test', role: 'viewer', status: 'active' }])
  if (pathname === '/api/github/connections') return result({ connections: [{ id: 'github-one', name: 'Engineering', account_login: 'example', token_last_four: 'demo', project_count: 4 }, { id: 'github-two', name: 'Client projects', account_login: 'client-example', token_last_four: 'test', project_count: 0 }] })
  if (pathname === '/api/github/repos') return result({ connected: true, repos: ['payments-api', 'customer-portal', 'operations-dashboard'].map((name, index) => ({ id: index, name, fullName: `example/${name}`, private: index === 0, defaultBranch: 'staging', cloneUrl: `https://github.com/example/${name}`, registered: false })) })
  if (pathname === '/api/sites') return result([state.project, { ...state.project, id: 'fixture-live', name: 'Customer portal', project_type: 'angular', setup_required: false, port: 3118, url: 'https://portal.example.test' }])
  if (pathname.endsWith('/related')) return result({ production_id: 'fixture-app', application_group_id: state.grouped ? 'fixture-group' : null, group_name: state.grouped ? 'Payments workspace' : null, component_role: 'backend', canWrite: state.role !== 'viewer', members: state.grouped ? [{ ...state.project, component_role: 'backend', database_count: 1, deployment_status: 'success' }, { ...state.project, id: 'fixture-live', name: 'Customer portal', project_type: 'angular', component_role: 'frontend', database_count: 0, deployment_status: 'success', port: 3118 }, { ...state.project, id: 'fixture-stage', name: 'Payments API (Staging)', environment: 'staging', component_role: 'backend', database_count: 1, deployment_status: 'success', port: 4117 }] : [], candidates: [{ id: 'fixture-live', name: 'Customer portal', project_type: 'angular', component_role: 'frontend' }] })
  if (/\/sites\/[^/]+$/.test(pathname)) return result(state.project)
  if (pathname.endsWith('/setup')) return result({ project: state.project, checkout: state.checkout, detectedType: state.checkout ? 'go' : undefined, envExists: !!state.env })
  if (pathname.endsWith('/env')) return result({ file: '.env', content: state.env })
  if (pathname.endsWith('/database')) return result({ database: null })
  if (pathname.endsWith('/data-services')) return result({ services: dataState.enabled ? listedServices() : state.services })
  if (pathname === '/api/data/connections') return result({ connections: [{ id: 'db-one', name: 'Shared PostgreSQL host', provider: 'postgresql', host: '127.0.0.1', port: 5432, last_status: 'healthy', is_default: true, provisioning_enabled: true }] })
  if (pathname === '/api/system/runtimes') return result({ runtimes: fixtureRuntimes() })
  if (pathname === '/api/system/runtimes/versions') return result({ installed: ['1.0.0'], available: [{ version: '1.0.0', label: '1.0.0' }, { version: '2.0.0', label: '2.0.0' }] })
  if (pathname === '/api/cloudflare/connections') return result({ connections: [{ id: 'cf-one', name: 'Example Cloudflare', token_last_four: 'demo', token_status: 'active', domain_count: 0 }] })
  if (pathname === '/api/cloudflare/zones') return result({ zones: [] })
  if (pathname === '/api/domains') return result({ domains: state.domains })
  if (pathname === '/api/deployments') return result([{ id: 'release-one', project_id: 'fixture-live', project_name: 'Customer portal', status: 'success', branch: 'main', commit_sha: 'a7e982104b', started_at: '2026-08-31T10:00:00Z', finished_at: '2026-08-31T10:02:00Z' }])
  if (pathname.endsWith('/console')) return result({ scripts: {}, commands: state.project.project_type === 'laravel' ? ['php --version', 'php artisan about', 'php artisan migrate:status'] : state.project.project_type === 'go' ? ['go version', 'go test ./...', 'go list ./...'] : ['node --version', 'npm run build'] })
  if (pathname.endsWith('/logs/stream')) return new Response('data: ' + JSON.stringify({ output: '[fixture] Application logs\n', status: 'online' }) + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  if (pathname.includes('/webhook')) return result({ hasSecret: false, installed: false })
  return result([])
}

export async function POST(request: Request) {
  const pathname = new URL(request.url).pathname
  const body = await request.json().catch(() => ({}))
  if (pathname === '/api/settings/test-notification') { settingsState.notifications++; return result({ ok: true }) }
  if (pathname === '/api/system/runtimes/check-updates') return result({ runtimes: fixtureRuntimes() })
  if (pathname === '/api/auth/github/device') return result({ deviceCode: 'fixture-device', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', interval: 5 })
  if (pathname === '/api/auth/github/poll') return result({ status: 'authorization_pending' })
  if (pathname === '/api/cloudflare/connections') return body.token === 'invalid-fixture-token' ? result({ error: 'Cloudflare API token is not active' }, 400) : result({ connection: { id: 'cf-fixture', name: body.name } }, 201)
  if (pathname.endsWith('/related')) { state.grouped = true; return result({ ok: true }) }
  if (pathname === '/api/__fixture') {
    if (body.reset) { state.project = { ...initialProject }; state.checkout = false; state.env = ''; state.domains = []; state.services = []; dataState.enabled = false }
    if (body.dataServices) {
      dataState.enabled = true; dataState.deleted = []
      dataState.services = ['primary', 'legacy', 'archive', 'backup'].map(name => ({ id: name, name, project_id: 'fixture-app', project_name: 'Payments API', environment: 'production', connection_id: 'db-one', connection_name: 'Shared PostgreSQL host', provider: 'postgresql', host: '127.0.0.1', port: 5432, database_name: `payments_${name}`, username: 'fixture_user', env_prefix: name.toUpperCase(), application_primary: name === 'primary', deployment_active: false, backup_status: name === 'backup' ? 'running' : null, options: { ownership: name === 'archive' ? 'external' : 'manager' } }))
      dataState.migrations = ['failed', 'activated', 'running'].map(status => ({ id: `migration-${status}`, project_id: 'fixture-app', project_name: 'Payments API', source_service_id: 'legacy', source_service_name: 'legacy', source_provider: 'postgresql', source_database: `legacy_${status}`, target_service_id: 'primary', target_service_name: 'primary', target_provider: 'mysql', target_database: `payments_${status}`, status, table_map: [], validation: [], log: 'Synthetic migration log', created_at: '2026-08-31T12:00:00Z' }))
    }
    state.failure = body.failure || ''; state.role = body.role || 'admin'; return result({ ok: true })
  }
  if (pathname === '/api/sites') { Object.assign(state.project, { name: body.name, repo_url: body.repoUrl, default_branch: body.defaultBranch, project_type: body.projectType, github_connection_id: body.githubConnectionId }); return result(state.project, 201) }
  if (pathname.endsWith('/setup')) {
    if (body.action === 'progress') { Object.assign(state.project, { step: body.step, decisions: { ...state.project.decisions, ...body.decisions } }); return result({ ok: true }) }
    if (body.action === 'prepare') { state.checkout = true; return new Response('[repository] Synthetic checkout ready\n', { headers: { 'Content-Type': 'text/plain' } }) }
    const checks = [
      { id: 'checkout', step: 'repository', label: 'Repository checkout', status: state.checkout ? 'pass' : 'fail', detail: state.project.root_path },
      { id: 'runtime', step: 'runtime', label: 'Selected runtime', status: state.failure ? 'fail' : 'pass', detail: state.failure || 'Runtime available' },
      { id: 'database', step: 'database', label: 'Database configuration', status: state.services.length ? 'pass' : state.project.decisions.database === 'none' ? 'warning' : 'fail', detail: state.services.length ? 'Attached' : 'No managed database selected' },
      { id: 'env', step: 'environment', label: 'Environment configuration', status: state.env ? 'pass' : state.project.decisions.environment === 'runtime' ? 'warning' : 'fail', detail: 'Application environment' },
      { id: 'dns', step: 'domain', label: 'Public domain', status: state.domains.length || state.project.decisions.domain === 'later' ? 'warning' : 'fail', detail: 'Public DNS and TLS require a running deployment' },
    ]
    const ready = !checks.some(check => check.status === 'fail')
    if (ready) { state.project.completed_at = new Date().toISOString(); state.project.setup_required = false }
    return result({ checks, ready })
  }
  if (pathname.endsWith('/env')) { state.env = body.content; return result({ ok: true }) }
  if (pathname.endsWith('/console')) return new Response('[fixture] Command preview\n[exit] Command finished with code 0\n')
  if (pathname.endsWith('/data-services')) { state.services.push({ id: 'service-one', name: body.name, provider: 'postgresql', connection_name: 'Shared PostgreSQL host', database_name: 'payments_db', username: 'payments_user', env_prefix: 'PRIMARY', application_primary: body.applicationPrimary, options: { ownership: 'manager' } }); return result({ service: state.services[0] }, 201) }
  if (pathname === '/api/domains') { state.domains.push({ id: 'domain-one', hostname: body.hostname, record_content: body.recordContent, dns_status: body.mode === 'manual' ? 'manual' : 'active', ssl_status: 'pending', cloudflare_connection_id: body.mode === 'manual' ? null : body.cloudflareConnectionId }); state.project.url = 'https://' + body.hostname; return result({ domain: state.domains[0] }, 201) }
  return result({ ok: true })
}
export async function PATCH(request: Request) {
  const body = await request.json()
  const map: Record<string, string> = { projectType: 'project_type', runtimeVersions: 'runtime_versions', buildCmd: 'build_cmd', startCmd: 'start_cmd', deployScript: 'deploy_script', autoDeploy: 'auto_deploy' }
  for (const [key, value] of Object.entries(body)) state.project[map[key] || key] = value
  return result(state.project)
}
export async function PUT(request: Request) {
  if (new URL(request.url).pathname !== '/api/settings') return result({ error: 'Not found' }, 404)
  if (state.role !== 'admin') return result({ error: 'Forbidden' }, 403)
  if (state.failure === 'settings-save') return result({ error: 'Fixture save failed' }, 503)
  const body = await request.json()
  settingsState.writes.push(body)
  Object.assign(settingsState.values, body)
  return result({ ok: true, updated: Object.keys(body) })
}
export async function DELETE(request: Request) {
  const pathname = new URL(request.url).pathname
  if (pathname.endsWith('/related')) state.grouped = false
  if (/\/data-services\/[^/]+$/.test(pathname) || /\/data\/migrations\/[^/]+$/.test(pathname)) {
    if (state.role !== 'admin') return result({ error: 'Forbidden' }, 403)
    if (state.failure === 'data-remove') return result({ error: 'This resource is now used by an active operation. Refresh and try again.' }, 409)
    const id = pathname.split('/').pop()
    const migration = dataState.migrations.find(job => job.id === id)
    const service = listedServices().find(item => item.id === id)
    if (!migration && !service) return result({ error: 'Not found' }, 404)
    const reason = migration ? migrationRemovalReason(migration.status) : service.removal_blocked_reason
    if (reason) return result({ error: reason }, 409)
    dataState.deleted.push(pathname)
    dataState.migrations = dataState.migrations.filter(job => job.id !== id)
    dataState.services = dataState.services.filter(item => item.id !== id)
  }
  return result({ ok: true })
}
