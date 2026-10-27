import { NextResponse } from 'next/server'
import { remoteSetupChecks } from '@/lib/remote-setup-policy'

const serverId = '11111111-1111-4111-8111-111111111111'
const windowsId = '22222222-2222-4222-8222-222222222222'
const appId = '33333333-3333-4333-8333-333333333333'
const app: Record<string, any> = { id: appId, server_id: serverId, name: 'Campus Library', repo_url: 'https://github.com/example/library', branch: 'main', install_cmd: 'npm ci --include=dev', build_cmd: 'npm run build', start_cmd: 'npm start -- --hostname 127.0.0.1', port: 3100, health_path: '/health', access_mode: 'lan', hostname: 'library.campus.example.edu', ip_address: '192.168.10.20', ip_port: 8443, git_connection_id: null, env_names: ['DATABASE_URL'], live_commit: 'a'.repeat(40), deployed_at: new Date().toISOString() }
const metrics = { hostname: 'campus-linux', platform: 'linux', version: '1.1.0', capabilities: ['guided-setup-v1'], cpuPercent: 23, memoryTotal: 16 * 1024 ** 3, memoryFree: 10 * 1024 ** 3, diskTotal: 500 * 1024 ** 3, diskFree: 350 * 1024 ** 3, uptime: 864000, addresses: ['192.168.10.20'], tools: { node: 'v24.13.0', git: 'git version 2.50', pm2: '6.0', caddy: 'v2.10' }, apps: [{ id: appId, status: 'online', cpu: 4, memory: 256 * 1024 ** 2 }], proxyError: null }
const initial = { role: 'admin', servers: [
  { id: serverId, name: 'Main campus', location: 'Accra · institution LAN', platform: 'linux', enabled: true, enrolled_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), metrics, status: 'online', app_count: 2, has_ca: true },
  { id: windowsId, name: 'Regional office', location: 'Kumasi · private network', platform: 'win32', enabled: true, enrolled_at: null, last_seen_at: null, metrics: null, status: 'pending', app_count: 0, has_ca: false },
], apps: [app, { ...app, id: '44444444-4444-4444-8444-444444444444', name: 'Student Records', port: 3200, hostname: 'records.campus.example.edu', ip_port: 8444, live_commit: null, deployed_at: null }], jobs: [
  { id: '55555555-5555-4555-8555-555555555555', app_id: appId, app_name: app.name, status: 'success', log: '[stage] checkout\n[stage] build\n[stage] health\n[stage] caddy\n[success] App healthy; routes loaded.', commit_sha: 'a'.repeat(40), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: new Date().toISOString() },
] }
const state = (globalThis as unknown as { __remoteFixture?: typeof initial }).__remoteFixture ??= initial
const variables = (globalThis as unknown as { __remoteEnvFixture?: Record<string,Record<string,string>> }).__remoteEnvFixture ??= {}
const setupJobs = (globalThis as unknown as { __remoteSetupJobsFixture?: Record<string,any>[] }).__remoteSetupJobsFixture ??= []

// Synthetic UI fixture only. No database, filesystem mutation or network agents.
export async function remoteServersFixture(request: Request) {
  const pathname = new URL(request.url).pathname
  if (!pathname.startsWith('/api/servers')) return null
  const parts = pathname.slice('/api/servers'.length).split('/').filter(Boolean)
  if (request.method === 'GET') {
    if(parts[1]==='apps' && ['setup','environment'].includes(parts[3])) {
      const target=state.apps.find(item=>item.id===parts[2] && item.server_id===parts[0])
      if(!target)return NextResponse.json({error:'Application not found'},{status:404})
      if(parts[3]==='environment')return NextResponse.json({environment:variables[target.id] || {}})
      return NextResponse.json({app:target,related:state.apps.filter(item=>item.id===(target.production_id||target.id)||item.production_id===(target.production_id||target.id)),jobs:setupJobs.filter(job=>job.app_id===target.id),checks:remoteSetupChecks(target as Parameters<typeof remoteSetupChecks>[0])})
    }
    for (const server of state.servers) if (server.status === 'online') server.last_seen_at = new Date().toISOString()
    if (!parts.length) return NextResponse.json({ servers: state.servers, role: state.role, userId: 'fixture-user', local: { hostname: 'synergy-manager', platform: 'win32' } })
    const apps = state.apps.filter(a => a.server_id === parts[0])
    return NextResponse.json({ server: state.servers.find(s => s.id === parts[0]), apps, jobs: state.jobs.filter(job => apps.some(app => app.id === job.app_id)), role: state.role })
  }
  const body = await request.json()
  if(parts[1]==='apps' && parts[2]==='import') {
    const environments=body.environmentMode==='production-staging'?['production','staging']:[body.environmentMode]
    const ids=environments.map(()=>crypto.randomUUID())
    for(let index=0;index<environments.length;index++) {
      const id=ids[index], framework=body.repo_url.includes('payments-api')?'go':'next', platform=state.servers.find(item=>item.id===parts[0])?.platform
      const commands=framework==='go'?{install_cmd:'go mod download',build_cmd:`go build -o ${platform==='win32'?'app.exe':'app'} .`,start_cmd:platform==='win32'?'.\\app.exe':'./app'}:{install_cmd:'npm ci --include=dev',build_cmd:'npm run build',start_cmd:'npm start'}
      state.apps.push({...app,...commands,id,name:body.name,repo_url:body.repo_url,branch:index===1?body.stagingBranch:body.branch,server_id:parts[0],environment_name:environments[index],production_id:index===1?ids[0]:null,guided_setup:true,project_type:framework,port:3500+state.apps.length,hostname:`app-${id}.invalid`,ip_address:'',ip_port:null,env_names:[],live_commit:null,deployed_at:null,setup_step:'runtime',setup_decisions:{},setup_completed_at:null,database_config:null,inspection:{framework,commit:'c'.repeat(40),commands,packageManager:framework==='go'?null:'npm',tools:{...metrics.tools,npm:'11',go:'go1.25',php:'8.4',composer:'2',psql:'18',mysql:'8.4',mariadb:'11'}}})
      setupJobs.unshift({id:crypto.randomUUID(),app_id:id,kind:'inspect',status:'success',log:'[preview] Repository inspected. No server was contacted.',created_at:new Date().toISOString()})
    }
    return NextResponse.json({id:ids[0],apps:ids.map((id,index)=>({id,environment:environments[index]}))})
  }
  if(parts[1]==='apps' && parts[3]==='setup') {
    const target=state.apps.find(item=>item.id===parts[2] && item.server_id===parts[0])!
    if(body.action==='save') {
      for(const key of ['project_type','install_cmd','build_cmd','start_cmd','port','health_path','access_mode','hostname','ip_address','ip_port'])if(Object.hasOwn(body,key))target[key]=body[key]
      target.setup_completed_at=null; target.setup_step=body.step
      if(body.environment){variables[target.id]=body.environment;target.env_names=Object.keys(body.environment)}
      if(body.environmentReviewed)target.setup_decisions.environment='reviewed'
      if(body.domainConfigured)target.setup_decisions.domain='configured'
      if(body.databaseNone){target.database_config=null;target.setup_decisions.database='none'}
    } else if(body.action==='progress')target.setup_step=body.step
    else if(body.action==='database') {
      target.database_config={provider:body.provider||'postgresql',host:body.host||'127.0.0.1',port:body.port||5432,database:body.database||'library_fixture',username:body.username||'library_user',status:'ready',tls:false};target.setup_decisions.database='configured'
    } else if(body.action==='validate')target.setup_completed_at=new Date().toISOString()
    if(body.action!=='save'&&body.action!=='progress')setupJobs.unshift({id:crypto.randomUUID(),app_id:target.id,kind:body.action,status:'success',log:'[preview] Operation completed using synthetic data.',created_at:new Date().toISOString()})
    return NextResponse.json({ok:true})
  }
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
