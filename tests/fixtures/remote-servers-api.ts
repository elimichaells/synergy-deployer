import { NextResponse } from 'next/server'

const serverId = '11111111-1111-4111-8111-111111111111'
const windowsId = '22222222-2222-4222-8222-222222222222'
const appId = '33333333-3333-4333-8333-333333333333'
const app = { id: appId, server_id: serverId, name: 'Campus Library', repo_url: 'https://github.com/example/library', branch: 'main', install_cmd: 'npm ci --include=dev', build_cmd: 'npm run build', start_cmd: 'npm start -- --hostname 127.0.0.1', port: 3100, health_path: '/health', access_mode: 'lan', hostname: 'library.campus.example.edu', ip_address: '192.168.10.20', ip_port: 8443, git_connection_id: null, env_names: ['DATABASE_URL'], live_commit: 'a'.repeat(40), deployed_at: new Date().toISOString() }
const metrics = { hostname: 'campus-linux', platform: 'linux', version: '1.0.0', cpuPercent: 23, memoryTotal: 16 * 1024 ** 3, memoryFree: 10 * 1024 ** 3, diskTotal: 500 * 1024 ** 3, diskFree: 350 * 1024 ** 3, uptime: 864000, addresses: ['192.168.10.20'], tools: { node: 'v24.13.0', git: 'git version 2.50', pm2: '6.0', caddy: 'v2.10' }, apps: [{ id: appId, status: 'online', cpu: 4, memory: 256 * 1024 ** 2 }], proxyError: null }
const initial = { role: 'admin', servers: [
  { id: serverId, name: 'Main campus', location: 'Accra · institution LAN', platform: 'linux', enabled: true, enrolled_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), metrics, status: 'online', app_count: 2, has_ca: true },
  { id: windowsId, name: 'Regional office', location: 'Kumasi · private network', platform: 'win32', enabled: true, enrolled_at: null, last_seen_at: null, metrics: null, status: 'pending', app_count: 0, has_ca: false },
], apps: [app, { ...app, id: '44444444-4444-4444-8444-444444444444', name: 'Student Records', port: 3200, hostname: 'records.campus.example.edu', ip_port: 8444, live_commit: null, deployed_at: null }], jobs: [
  { id: '55555555-5555-4555-8555-555555555555', app_id: appId, app_name: app.name, status: 'success', log: '[stage] checkout\n[stage] build\n[stage] health\n[stage] caddy\n[success] App healthy; routes loaded.', commit_sha: 'a'.repeat(40), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: new Date().toISOString() },
] }
const state = (globalThis as unknown as { __remoteFixture?: typeof initial }).__remoteFixture ??= initial

// Synthetic UI fixture only. No database, filesystem mutation or network agents.
export async function remoteServersFixture(request: Request) {
  const pathname = new URL(request.url).pathname
  if (!pathname.startsWith('/api/servers')) return null
  const parts = pathname.slice('/api/servers'.length).split('/').filter(Boolean)
  if (request.method === 'GET') {
    for (const server of state.servers) if (server.status === 'online') server.last_seen_at = new Date().toISOString()
    if (!parts.length) return NextResponse.json({ servers: state.servers, role: state.role, userId: 'fixture-user', local: { hostname: 'synergy-manager', platform: 'win32' } })
    const apps = state.apps.filter(a => a.server_id === parts[0])
    return NextResponse.json({ server: state.servers.find(s => s.id === parts[0]), apps, jobs: state.jobs.filter(job => apps.some(app => app.id === job.app_id)), role: state.role })
  }
  const body = await request.json()
  if (parts[0] === '__fixture') {
    if (['admin', 'operator', 'viewer'].includes(body.role)) state.role = body.role
    const server = state.servers.find(item => item.id === body.serverId)
    if (server && ['online', 'offline', 'pending', 'revoked'].includes(body.status)) {
      server.status = body.status
      if (body.status === 'online') { server.enrolled_at = new Date().toISOString(); server.metrics = { ...metrics, platform: server.platform, hostname: server.platform === 'win32' ? 'regional-windows' : 'campus-linux', apps: server.id === serverId ? metrics.apps : [] } }
    }
    return NextResponse.json({ ok: true })
  }
  if (!parts.length) {
    const id = crypto.randomUUID()
    state.servers.push({ ...state.servers[1], ...body, id, app_count: 0, enrolled_at: null, last_seen_at: null, metrics: null, status: 'pending', has_ca: false })
    return NextResponse.json({ id, enrollmentToken: 'fixture-token-for-preview-only', expiresInMinutes: 60 })
  }
  if (parts[1] === 'ssh') {
    if (body.action === 'probe') return NextResponse.json({ fingerprint: 'SHA256:PreviewOnlyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })
    const server = state.servers.find(s => s.id === parts[0])!
    server.enrolled_at = new Date().toISOString(); server.last_seen_at = server.enrolled_at; server.status = 'online'
    server.metrics = { ...metrics, platform: server.platform, hostname: 'regional-windows', addresses: [body.host], apps: [] }
    return NextResponse.json({ online: true, message: 'Preview: agent installed and reporting to Manager.', log: '[preview] Synthetic SSH setup only. No server was contacted.\n[setup] Identity checked\n[setup] Tools installed\n[setup] Agent reporting' })
  }
  if (parts.length === 1 && body.action === 'enrollment') return NextResponse.json({ enrollmentToken: 'fixture-token-for-preview-only' })
  if (parts[1] === 'apps' && parts.length === 2) {
    const id = crypto.randomUUID()
    state.apps.push({ ...app, ...body, id, server_id: parts[0], port: Number(body.port), ip_port: Number(body.ip_port), env_names: Object.keys(body.environment || {}), live_commit: null, deployed_at: null })
    return NextResponse.json({ id })
  }
  if (parts[3] === 'deploy') {
    const target = state.apps.find(a => a.id === parts[2])!
    const id = crypto.randomUUID()
    state.jobs.unshift({ ...state.jobs[0], id, app_id: target.id, app_name: target.name, status: 'queued', log: '' })
    return NextResponse.json({ id })
  }
  return NextResponse.json({ ok: true })
}
