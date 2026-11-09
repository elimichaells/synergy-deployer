import { ApiError } from '@/lib/api'
import { audit } from '@/lib/audit'
import { db, query } from '@/lib/db'
import { repositoryPath,repositoryUrl } from '@/lib/git-provider-policy'
import { getGitConnection, getGitHubConnectionToken } from '@/lib/github-connections'
import { cleanInspection, REMOTE_SETUP_CAPABILITY } from '@/lib/remote-setup-policy'
import { decryptSecret, encryptSecret } from '@/lib/secret-crypto'
import { databaseEnvironment, jobSecrets, INFRASTRUCTURE_CAPABILITY, PROTOCOL_VERSION, CONSOLE_CAPABILITY, RUNTIME_CAPABILITY, LAN_CAPABILITY, validateLanSelection, validateRuntimeSelection, redact, sanitizeMetrics, validateApp } from '@/scripts/manager-agent.cjs'
import { createHash, randomBytes, X509Certificate } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ManagedServer, RemoteApp } from './managed-server-types'
import { parseLanAddress } from '../scripts/lan-address.cjs'
import { remoteGateState } from '@/lib/remote-security-gate-policy'
import { loadAuditExceptions } from '@/lib/deployment-cache'
import { gateOffUntil, type GateScope } from '@/lib/security-gate-policy'
import { promotionReview,promotionProblem } from '../scripts/remote-promotion-policy.cjs'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const token = () => randomBytes(32).toString('base64url')
const serverColumns = `s.id,s.name,s.location,s.platform,s.enabled,s.enrolled_at,s.last_seen_at,s.metrics,
  (s.ca_pem is not null) as has_ca,
  (select count(*)::int from remote_apps a where a.server_id=s.id) as app_count`
const appColumns = `id,server_id,name,repo_url,branch,install_cmd,build_cmd,start_cmd,deploy_script,pre_deploy_cmd,post_deploy_cmd,port,health_path,
  access_mode,hostname,ip_address,ip_port,git_connection_id,env_names,live_commit,deployed_at,
  environment_name,production_id,project_type,guided_setup,setup_step,setup_completed_at,database_config,runtime_versions,
  application_group_id,component_role,health_profile,auto_deploy,(select g.name from remote_application_groups g where g.id=remote_apps.application_group_id and g.server_id=remote_apps.server_id) as group_name`
let schema: Promise<void> | null = null

export function ensureManagedServers() {
  if (!schema) schema = (async () => {
    const sql = await readFile(path.join(process.cwd(), 'db/migrations/025_managed_servers.sql'), 'utf8')
    const client = await db.connect()
    try {
      await client.query('begin')
      await client.query("select pg_advisory_xact_lock(hashtext('manager-managed-servers-schema'))")
      await client.query(sql)
      await client.query(await readFile(path.join(process.cwd(), 'db/migrations/026_remote_app_setup.sql'), 'utf8'))
      await client.query(await readFile(path.join(process.cwd(), 'db/migrations/027_remote_agent_updates.sql'), 'utf8'))
      await client.query(await readFile(path.join(process.cwd(), 'db/migrations/028_remote_operations.sql'), 'utf8'))
      await client.query(await readFile(path.join(process.cwd(), 'db/migrations/029_remote_infrastructure.sql'), 'utf8'))
      await client.query(await readFile(path.join(process.cwd(), 'db/migrations/030_remote_resources.sql'), 'utf8'))
      await client.query(await readFile(path.join(process.cwd(), 'db/migrations/031_remote_application_groups.sql'), 'utf8'))
      await client.query(await readFile(path.join(process.cwd(), 'db/migrations/033_remote_application_controls.sql'), 'utf8'))
      await client.query(await readFile(path.join(process.cwd(), 'db/migrations/034_remote_storage.sql'), 'utf8'))
      await client.query('commit')
    } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  })().catch(error => { schema = null; throw error })
  return schema
}

function status(server: ManagedServer): ManagedServer {
  return { ...server, status: !server.enabled ? 'revoked' : !server.enrolled_at ? 'pending' :
    server.last_seen_at && Date.now() - new Date(server.last_seen_at).getTime() < 90_000 ? 'online' : 'offline' }
}

export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)) throw new ApiError('Invalid identifier', 400)
  return value
}

function text(value: unknown, name: string, max = 100) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) throw new ApiError(`Invalid ${name}`, 400)
  return value.trim()
}

export async function listServers() {
  await ensureManagedServers()
  return (await query<ManagedServer>(`select ${serverColumns} from managed_servers s order by s.created_at`)).rows.map(status)
}

export async function serverDetail(id: string, jobId?:string|null) {
  await ensureManagedServers()
  const result = await query<ManagedServer>(`select ${serverColumns} from managed_servers s where s.id=$1`, [uuid(id)])
  if (!result.rows[0]) throw new ApiError('Server not found', 404)
  const [apps, jobs] = await Promise.all([
    query<RemoteApp>(`select ${appColumns} from remote_apps where server_id=$1 order by name`, [id]),
    query(`select j.id,j.app_id,a.name as app_name,j.kind,j.status,j.log,j.commit_sha,j.created_at,j.started_at,j.finished_at,j.updated_at,j.cancel_requested,j.trigger,j.branch,j.security_status
      from remote_jobs j join remote_apps a on a.id=j.app_id where j.server_id=$1 and j.kind='deploy' order by j.created_at desc limit 30`, [id]),
  ])
  if(jobId&&!jobs.rows.some(job=>job.id===jobId))jobs.rows.push(...(await remoteDeploymentHistory(id,{jobId})).jobs)
  return { server: status(result.rows[0]), apps: apps.rows, jobs: jobs.rows }
}

export async function remoteDeploymentHistory(serverId:string,options:{appId?:string|null;before?:string|null;jobId?:string|null;groupId?:string|null}={}) {
  await ensureManagedServers();uuid(serverId)
  const appId=options.appId?uuid(options.appId):null,before=options.before?uuid(options.before):null,jobId=options.jobId?uuid(options.jobId):null
  const groupId=options.groupId?uuid(options.groupId):null
  if(appId&&!(await query('select 1 from remote_apps where server_id=$1 and id=$2',[serverId,appId])).rowCount)throw new ApiError('Application not found on this server',404)
  if(before&&!(await query("select 1 from remote_jobs where server_id=$1 and id=$2 and kind='deploy' and ($3::uuid is null or app_id=$3)",[serverId,before,appId])).rowCount)throw new ApiError('History cursor not found on this server',404)
  const rows=(await query(`select j.id,j.app_id,a.name as app_name,j.kind,j.status,j.log,j.commit_sha,j.created_at,j.started_at,j.finished_at,j.updated_at,j.cancel_requested,j.trigger,j.branch,j.security_status
    from remote_jobs j join remote_apps a on a.id=j.app_id where j.server_id=$1 and j.kind='deploy' and ($2::uuid is null or j.app_id=$2) and ($4::uuid is null or j.id=$4)
    and ($5::uuid is null or a.application_group_id=$5) and ($3::uuid is null or (j.created_at,j.id)<(select created_at,id from remote_jobs where id=$3 and server_id=$1)) order by j.created_at desc,j.id desc limit 51`,[serverId,appId,before,jobId,groupId])).rows
  return{jobs:rows.slice(0,50),next:rows.length>50?rows[49].id:null}
}

export async function addServer(body: Record<string, unknown>, userId: string) {
  await ensureManagedServers()
  if (body.platform !== 'win32' && body.platform !== 'linux') throw new ApiError('Choose Windows or Linux', 400)
  const enrollmentToken = token()
  const { rows } = await query(`insert into managed_servers (name,location,platform,enrollment_hash,enrollment_expires_at)
    values ($1,$2,$3,$4,now()+interval '1 hour') returning id`,
  [text(body.name, 'server name'), body.location ? text(body.location, 'location') : '', body.platform, hash(enrollmentToken)])
  await audit(userId, 'server.create', rows[0].id, { name: body.name, platform: body.platform })
  return { id: rows[0].id, enrollmentToken, expiresInMinutes: 60 }
}

export async function renameServer(id: string, body: Record<string, unknown>, userId: string) {
  uuid(id)
  const name = text(body.name, 'server name')
  if (typeof body.previousName !== 'string' || body.previousName.length > 100) throw new ApiError('The current server name is required', 400)
  await ensureManagedServers()
  // Compare the displayed name to avoid silently overwriting another administrator's rename.
  const result = await query('update managed_servers set name=$2 where id=$1 and name=$3 returning id,name', [id, name, body.previousName])
  if (!result.rowCount) {
    if (!(await query('select id from managed_servers where id=$1', [id])).rowCount) throw new ApiError('Server not found', 404)
    throw new ApiError('This server was renamed elsewhere. Refresh the page and try again with its current name.', 409)
  }
  if (name !== body.previousName) await audit(userId, 'server.rename', id, { previousName: body.previousName, name })
  return result.rows[0] as { id: string; name: string }
}

export async function changeServer(id: string, action: unknown, userId: string) {
  await ensureManagedServers(); uuid(id)
  if (action === 'enrollment') {
    const enrollmentToken = token()
    const result = await query(`update managed_servers set enrollment_hash=$2,enrollment_expires_at=now()+interval '1 hour'
      where id=$1 and enrolled_at is null and enabled=true returning id`, [id, hash(enrollmentToken)])
    if (!result.rowCount) throw new ApiError('Only a pending server can receive a new enrollment token', 409)
    await audit(userId, 'server.enrollment.rotate', id)
    return { id, enrollmentToken, expiresInMinutes: 60 }
  }
  if (action !== 'revoke') throw new ApiError('Unknown action', 400)
  const client = await db.connect()
  try {
    await client.query('begin')
    const result = await client.query('update managed_servers set enabled=false,agent_hash=null,enrollment_hash=null where id=$1 returning id', [id])
    if (!result.rowCount) throw new ApiError('Server not found', 404)
    await client.query(`update remote_jobs set status='cancelled',payload_ciphertext=null,finished_at=now(),updated_at=now(),
      log=log||E'\n[revoked] Server access revoked. A running operation may still finish on the server; inspect it locally.\n'
      where server_id=$1 and status in ('queued','running')`, [id])
    await client.query("update remote_agent_updates set status='cancelled',source=null,finished_at=now(),updated_at=now(),message='Server access revoked; inspect any installation in progress locally' where server_id=$1 and status in ('queued','installing','recovery_required')", [id])
    await client.query('commit')
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  await audit(userId, 'server.revoke', id)
  return { ok: true }
}

export async function enroll(body: Record<string, unknown>) {
  await ensureManagedServers()
  const id = uuid(body.serverId)
  if (body.protocol !== PROTOCOL_VERSION) throw new ApiError('Download the current agent from Manager', 409)
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(body.enrollmentToken)) || !/^[A-Za-z0-9_-]{43}$/.test(String(body.agentToken))) throw new ApiError('Invalid enrollment credentials', 401)
  const agentHash = hash(String(body.agentToken))
  // The agent persists its own random credential BEFORE enrolling. Retrying a lost response is safe.
  const result = await query(`update managed_servers set agent_hash=$4,enrollment_hash=null,enrollment_expires_at=null,
    enrolled_at=coalesce(enrolled_at,now()),last_seen_at=now()
    where id=$1 and enabled=true and platform=$2 and
    ((enrollment_hash=$3 and enrollment_expires_at>now() and enrolled_at is null) or agent_hash=$4) returning id`,
  [id, body.platform, hash(String(body.enrollmentToken)), agentHash])
  if (!result.rowCount) throw new ApiError('Enrollment expired, already used, revoked, or operating system does not match', 401)
  return { serverId: id, protocol: PROTOCOL_VERSION }
}

export async function authenticateAgent(request: Request) {
  await ensureManagedServers()
  const auth = request.headers.get('authorization') || ''
  if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) throw new ApiError('Agent authentication required', 401)
  const result = await query<{ id: string; platform: string }>('select id,platform from managed_servers where agent_hash=$1 and enabled=true', [hash(auth.slice(7))])
  if (!result.rows[0]) throw new ApiError('Agent access revoked or invalid', 401)
  return result.rows[0]
}

export async function heartbeat(server: { id: string; platform: string }, body: Record<string, unknown>) {
  let metrics
  try { metrics = sanitizeMetrics(body.metrics) } catch { throw new ApiError('Invalid monitoring sample', 400) }
  if (metrics.platform !== server.platform || body.protocol !== PROTOCOL_VERSION) throw new ApiError('Agent platform or protocol mismatch', 409)
  let certificate: string | null = null
  if (body.caPem) {
    try {
      const raw = String(body.caPem)
      if (raw.length > 8192 || !/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/.test(raw) || raw.includes('PRIVATE KEY')) throw new Error()
      const cert = new X509Certificate(raw)
      if (!cert.ca) throw new Error()
      certificate = cert.toString()
    } catch { throw new ApiError('Invalid public CA certificate', 400) }
  }
  await query('update managed_servers set last_seen_at=now(),metrics=$2::jsonb,ca_pem=coalesce($3,ca_pem) where id=$1 and enabled=true', [server.id, JSON.stringify(metrics), certificate])
  if(metrics.capabilities?.includes(INFRASTRUCTURE_CAPABILITY))await (await import('@/lib/remote-health')).recordRemoteHealth(server.id,metrics)
  if(metrics.resources)await (await import('@/lib/remote-resources')).recordRemoteMemory(server.id,metrics)
  return { ok: true }
}

export async function serverCertificate(id: string) {
  await ensureManagedServers()
  const result = await query<{ ca_pem: string | null }>('select ca_pem from managed_servers where id=$1', [uuid(id)])
  if (!result.rows[0]?.ca_pem) throw new ApiError('CA not available yet. Deploy an internal site and wait for the next heartbeat.', 404)
  return result.rows[0].ca_pem
}

export async function saveRemoteApp(serverId: string, appId: string | null, body: Record<string, unknown>, userId: string) {
  await ensureManagedServers(); uuid(serverId); if (appId) uuid(appId)
  let app: ReturnType<typeof validateApp>
  try { app = validateApp(body) } catch (error) { throw new ApiError((error as Error).message, 400) }
  const connectionId = body.git_connection_id ? uuid(body.git_connection_id) : null
  if (connectionId) repositoryPath(app.repo_url, await getGitConnection(connectionId))
  const client = await db.connect()
  let savedId = ''
  try {
    await client.query('begin')
    const server = await client.query('select id,metrics from managed_servers where id=$1 and enabled=true for update', [serverId])
    if (!server.rowCount) throw new ApiError('Server is revoked or missing', 409)
    if (appId && (await client.query('select id from remote_apps where id=$1 and server_id=$2 and guided_setup=true', [appId,serverId])).rowCount) throw new ApiError('Use guided setup to change this application', 409)
    if (appId && (await client.query("select id from remote_jobs where (app_id=$1 or server_id=$2 and resource_action='storage') and status in ('queued','running')", [appId,serverId])).rowCount) throw new ApiError('Wait for the active application or storage operation before editing this app', 409)
    if(appId&&body.runtime_versions===undefined)app.runtime_versions=(await client.query('select runtime_versions from remote_apps where id=$1 and server_id=$2',[appId,serverId])).rows[0]?.runtime_versions||{}
    if(appId&&body.health_path===undefined)app.health_path=(await client.query('select health_path from remote_apps where id=$1 and server_id=$2',[appId,serverId])).rows[0]?.health_path||'/'
    if(appId){const previous=(await client.query('select deploy_script,pre_deploy_cmd,post_deploy_cmd from remote_apps where id=$1 and server_id=$2',[appId,serverId])).rows[0];for(const key of ['deploy_script','pre_deploy_cmd','post_deploy_cmd'] as const)if(body[key]===undefined)app[key]=previous?.[key]||''}
    try{validateRuntimeSelection(app.runtime_versions,server.rows[0].metrics);validateLanSelection(app.hostname,server.rows[0].metrics)}catch(error){throw new ApiError((error as Error).message,409)}
    const collision = await client.query(`select name from remote_apps where server_id=$1 and ($2::uuid is null or id<>$2)
      and (hostname=$3 or port=$4 or port=$5 or ip_port=$4 or ip_port=$5)`, [serverId, appId, app.hostname, app.port, app.ip_port])
    if (collision.rowCount) throw new ApiError('Hostname or port is already assigned to another app on this server', 409)
    let envCipher: string
    let envNames: string[]
    if (appId && body.environment === undefined) {
      const previous = (await client.query('select env_ciphertext,env_names from remote_apps where id=$1 and server_id=$2', [appId, serverId])).rows[0]
      if (!previous) throw new ApiError('App not found', 404)
      envCipher = previous.env_ciphertext; envNames = previous.env_names
    } else { envCipher = encryptSecret(JSON.stringify(app.environment)); envNames = Object.keys(app.environment).sort() }
    const values = [serverId,app.name,app.repo_url,app.branch,app.install_cmd,app.build_cmd,app.start_cmd,app.port,app.health_path,
      app.access_mode,app.hostname,app.ip_address,app.ip_port,connectionId,envCipher,envNames]
    const result = appId ? await client.query(`update remote_apps set name=$2,repo_url=$3,branch=$4,install_cmd=$5,build_cmd=$6,start_cmd=$7,
      port=$8,health_path=$9,access_mode=$10,hostname=$11,ip_address=$12,ip_port=$13,git_connection_id=$14,env_ciphertext=$15,env_names=$16
      where server_id=$1 and id=$17 returning id`, [...values, appId]) :
      await client.query(`insert into remote_apps (server_id,name,repo_url,branch,install_cmd,build_cmd,start_cmd,port,health_path,
        access_mode,hostname,ip_address,ip_port,git_connection_id,env_ciphertext,env_names)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`, values)
    if (!result.rowCount) throw new ApiError('App not found', 404)
    savedId = result.rows[0].id
    if(body.environment!==undefined)await client.query('update remote_apps set env_files_ciphertext=null where id=$1',[savedId])
    await client.query('update remote_apps set runtime_versions=$2::jsonb where id=$1',[savedId,JSON.stringify(app.runtime_versions)])
    await client.query('update remote_apps set deploy_script=$2,pre_deploy_cmd=$3,post_deploy_cmd=$4 where id=$1',[savedId,app.deploy_script,app.pre_deploy_cmd,app.post_deploy_cmd])
    await client.query('commit')
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  await audit(userId, appId ? 'remote.app.update' : 'remote.app.create', savedId, { serverId })
  return { id: savedId }
}

export async function queueRemoteRollback(serverId:string,jobId:string,userId:string) {
  await ensureManagedServers()
  const target=(await query("select app_id from remote_jobs where server_id=$1 and id=$2 and kind='deploy'",[uuid(serverId),uuid(jobId)])).rows[0]
  if(!target?.app_id)throw new ApiError('Deployment not found on this server',404)
  return queueRemoteDeploy(serverId,target.app_id,userId,{rollbackJobId:jobId})
}
export async function queueRemoteDeploy(serverId: string, appId: string, userId: string, options:{promotion?:{stagingId:string;commit:string;review:string};rollbackJobId?:string;override?:{jobId:string;scope:GateScope;reason:string};webhook?:{repository:string;branch:string;sha:string;secretHash:string}}={}) {
  await ensureManagedServers(); uuid(serverId); uuid(appId)
  // Resolve credentials BEFORE holding a transaction connection. A burst of queued
  // requests must not exhaust the pool while one holder needs a second connection.
  const before = (await query<{ git_connection_id: string | null }>('select git_connection_id from remote_apps where id=$1 and server_id=$2', [appId, serverId])).rows[0]
  if (!before) throw new ApiError('App not found', 404)
  const connection = before.git_connection_id ? await getGitConnection(before.git_connection_id) : null
  const git = connection ? { username: connection.provider === 'github' ? 'x-access-token' : connection.account_login,
    token: await getGitHubConnectionToken(before.git_connection_id, false), caPem: connection.ca_pem } : null
  const client = await db.connect()
  let jobId = ''
  try {
    await client.query('begin')
    const server = (await client.query('select * from managed_servers where id=$1 for update', [serverId])).rows[0]
    if (!server?.enabled || !server.enrolled_at) throw new ApiError('Enroll an active server first', 409)
    const app = (await client.query('select * from remote_apps where id=$1 and server_id=$2', [appId, serverId])).rows[0]
    if (!app) throw new ApiError('App not found', 404)
    let commitSha:string|undefined
    let promotion:{stagingId:string;sourceCommit:string;branch:string;mode:'commit'|'merge'}|undefined
    let reviewedPromotion=options.promotion
    if(options.webhook){
      const push=options.webhook
      if(!app.auto_deploy||app.webhook_user_id!==userId||!app.webhook_ciphertext||hash(app.webhook_ciphertext)!==push.secretHash||app.branch!==push.branch||repositoryUrl(app.repo_url)!==push.repository||!/^[a-f0-9]{40,64}$/.test(push.sha))throw new ApiError('Git automation changed. This delivery is no longer authorized.',409)
      if(app.live_commit===push.sha){const live=(await client.query("select id from remote_jobs where server_id=$1 and app_id=$2 and status='success' and commit_sha=$3 and repo_url=$4 order by created_at desc limit 1",[serverId,appId,push.sha,app.repo_url])).rows[0];if(live){await client.query('commit');return{id:live.id}}}
      const duplicate=(await client.query("select id from remote_jobs where server_id=$1 and app_id=$2 and trigger='webhook' and requested_commit=$3 and branch=$4 and repo_url=$5 order by created_at desc limit 1",[serverId,appId,push.sha,push.branch,app.repo_url])).rows[0]
      if(duplicate){await client.query('commit');return{id:duplicate.id}}
      commitSha=push.sha
    }
    if(options.override){
      const stopped=(await client.query("select * from remote_jobs where server_id=$1 and app_id=$2 and id=$3 and kind='deploy' and status='failed' and security_status='failed' and not exists(select 1 from remote_jobs n where n.app_id=$2 and n.kind='deploy' and n.created_at>remote_jobs.created_at)",[serverId,appId,uuid(options.override.jobId)])).rows[0]
      if(!stopped)throw new ApiError('Only the newest deployment stopped by the security gate can be overridden',409)
      if(stopped.repo_url&&stopped.repo_url!==app.repo_url)throw new ApiError('The repository changed. Start a new reviewed deployment.',409)
      if(stopped.branch&&stopped.branch!==app.branch)throw new ApiError('The deployment branch changed. Start a new reviewed deployment.',409)
      if(stopped.trigger==='promote'){
        if(!stopped.promotion_options)throw new ApiError('This older promotion has no saved review. Review staging promotion again.',409)
        reviewedPromotion=stopped.promotion_options
      }
      commitSha=stopped.requested_commit||undefined
      if(options.override.scope!=='once'){
        app.security_gate={until:gateOffUntil(options.override.scope),reason:options.override.reason,userId,at:new Date().toISOString()}
        await client.query('update remote_apps set security_gate=$2 where id=$1',[appId,JSON.stringify(app.security_gate)])
      }
    }
    if(reviewedPromotion){
      const requested=reviewedPromotion,staging=(await client.query('select * from remote_apps where server_id=$1 and id=$2',[serverId,uuid(requested.stagingId)])).rows[0]
      const problem=promotionProblem(staging,app);if(problem)throw new ApiError(problem,409)
      if(staging.live_commit!==requested.commit||promotionReview(serverId,staging,app)!==requested.review)throw new ApiError('Staging or production changed. Review the promotion again.',409)
      promotion={stagingId:staging.id,sourceCommit:staging.live_commit,branch:staging.branch,mode:staging.branch===app.branch?'commit':'merge'}
      commitSha=promotion.mode==='commit'?promotion.sourceCommit:undefined
    }
    if(options.rollbackJobId){
      if(!server.metrics?.capabilities?.includes('application-control-v1'))throw new ApiError('Update the agent before restoring a previous commit',409)
      const target=(await client.query("select * from remote_jobs where server_id=$1 and app_id=$2 and id=$3 and kind='deploy' and status='success'",[serverId,appId,uuid(options.rollbackJobId)])).rows[0]
      if(!target?.commit_sha||!/^[a-f0-9]{40,64}$/.test(target.commit_sha))throw new ApiError('Choose a successful deployment with a recorded commit',400)
      if(target.repo_url&&target.repo_url!==app.repo_url)throw new ApiError('The repository has changed since this deployment. Restore its repository settings before rolling back.',409)
      commitSha=target.commit_sha
    }
    if (app.guided_setup && !app.setup_completed_at) throw new ApiError('Complete guided setup and server checks before deploying this environment', 409)
    validateLanSelection(app.hostname,server.metrics)
    if (app.guided_setup && !server.metrics?.capabilities?.includes(REMOTE_SETUP_CAPABILITY)) throw new ApiError('Update the agent before deploying this guided application',409)
    if ((await client.query("select id from remote_jobs where (app_id=$1 or server_id=$2 and resource_action='storage') and status in ('queued','running')", [appId,serverId])).rowCount) throw new ApiError('Wait for the current application or storage operation before deploying', 409)
    if((await client.query("select 1 from remote_storage_renames where server_id=$1 and status in ('running','needs_review') and apps @> $2::jsonb",[serverId,JSON.stringify([{projectId:appId}])])).rowCount)throw new ApiError('Verify the pending database rename before deploying this application',409)
    if (app.git_connection_id !== before.git_connection_id) throw new ApiError('Git connection changed. Retry deployment.', 409)
    if (connection) repositoryPath(app.repo_url, connection)
    const database = app.database_config?.status === 'ready' && app.database_ciphertext ? JSON.parse(decryptSecret(app.database_ciphertext)) : null
    const managedEnvironment=app.storage_catalog_enabled?await (await import('./remote-storage')).remoteStorageEnvironment(client,serverId,app):database?databaseEnvironment(database):{}
    const environment = { ...JSON.parse(decryptSecret(app.env_ciphertext)), ...managedEnvironment }
    try{validateRuntimeSelection(app.runtime_versions||{},server.metrics)}catch(error){throw new ApiError((error as Error).message,409)}
    if(!server.metrics?.capabilities?.includes('application-control-v1'))throw new ApiError('Update the agent before deploying with the application security gate and readiness controls',409)
    const payload = { ...validateApp({ ...app, environment }), id: app.id, git, project_type: app.project_type,environmentFiles:app.env_files_ciphertext?JSON.parse(decryptSecret(app.env_files_ciphertext)):undefined,managedEnvironment,commitSha,promotion,securityGate:options.override?.scope==='once'?{off:true,once:true,reason:options.override.reason}:remoteGateState(app.security_gate),auditExceptions:loadAuditExceptions().filter(entry=>entry.projectId===app.id), requiredCapability:'application-control-v1' }
    const result = await client.query(`insert into remote_jobs (server_id,app_id,user_id,payload_ciphertext,trigger,branch,repo_url,requested_commit,promotion_options) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [serverId, appId, userId, encryptSecret(JSON.stringify(payload)),promotion?'promote':options.webhook?'webhook':options.rollbackJobId?'rollback':'manual',app.branch,app.repo_url,commitSha||null,reviewedPromotion?JSON.stringify(reviewedPromotion):null])
    jobId = result.rows[0].id
    if(options.override)await client.query('insert into audit_logs(user_id,action,resource,details) values($1,$2,$3,$4)',[userId,'remote.security_gate.override',appId,JSON.stringify({...options.override,serverId,queuedJobId:jobId})])
    await client.query('commit')
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  await audit(userId, 'remote.deploy.queue', appId, { serverId, jobId })
  return { id: jobId }
}

export async function claimJob(serverId: string) {
  const client = await db.connect()
  try {
    await client.query('begin')
    const server = await client.query('select id,metrics from managed_servers where id=$1 and enabled=true for update', [serverId])
    if (!server.rowCount) throw new ApiError('Server revoked', 401)
    if ((await client.query("select 1 from remote_service_operations where server_id=$1 and status in ('running','interrupted')",[serverId])).rowCount) { await client.query('commit'); return {job:null,protocol:PROTOCOL_VERSION,paused:true} }
    // One job per server. A disconnected claim remains assigned, NEVER automatically re-executed.
    let job = (await client.query("select * from remote_jobs where server_id=$1 and status='running'", [serverId])).rows[0]
    if (!job && (await client.query("select id from remote_agent_updates where server_id=$1 and status in ('queued','installing','recovery_required')", [serverId])).rowCount) {
      await client.query('commit'); return { job:null, protocol:PROTOCOL_VERSION }
    }
    if (!job) job = (await client.query(`update remote_jobs set status='running',claim_token=$2,started_at=now(),updated_at=now()
      where id=(select id from remote_jobs where server_id=$1 and status='queued' and (kind='deploy' or kind in ('inspect','database','validate') and $3 or kind in ('console','logs') and $4) order by created_at limit 1)
      returning *`, [serverId, token(), server.rows[0].metrics?.capabilities?.includes(REMOTE_SETUP_CAPABILITY) === true, server.rows[0].metrics?.capabilities?.includes(CONSOLE_CAPABILITY) === true])).rows[0]
    // An older agent must never execute a setup payload as a deployment, including after a downgrade.
    const payload = job ? JSON.parse(decryptSecret(job.payload_ciphertext)) : null
    const capable = !job || (job.kind === 'deploy' && !payload.requiredCapability) || server.rows[0].metrics?.capabilities?.includes(payload.requiredCapability || REMOTE_SETUP_CAPABILITY) === true
    const result = job && capable ? { id: job.id, kind: job.operation_type==='infrastructure'?'infrastructure':job.kind, claimToken: job.claim_token, payload } : null
    await client.query('commit')
    return { job: result, protocol: PROTOCOL_VERSION }
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
}

export async function reportJob(serverId: string, body: Record<string, unknown>) {
  const id = uuid(body.id)
  if (!['running','success','failed'].includes(String(body.status)) || typeof body.log !== 'string' || body.log.length > 131072 ||
    !Number.isSafeInteger(body.sequence) || Number(body.sequence) < 1 || (body.commitSha && !/^[a-f0-9]{40,64}$/.test(String(body.commitSha)))) throw new ApiError('Invalid job report', 400)
  const client = await db.connect()
  try {
    await client.query('begin')
    // Use the same lock order as admission/removal: server, then job/application.
    await client.query('select id from managed_servers where id=$1 for update', [serverId])
    const job = (await client.query('select * from remote_jobs where id=$1 and server_id=$2 and claim_token=$3 for update', [id,serverId,body.claimToken])).rows[0]
    if (!job) throw new ApiError('Job does not belong to this agent', 404)
    if (job.status !== 'running' || Number(body.sequence) <= job.report_sequence) { await client.query('commit'); return { ok: true, cancelRequested:job.cancel_requested || job.status==='cancelled' } }
    const payload = JSON.parse(decryptSecret(job.payload_ciphertext))
    const secrets = jobSecrets(payload)
    const log = redact(body.log, secrets)
    const finished = body.status !== 'running'
    const kind = job.operation_type==='infrastructure'?'infrastructure':job.kind || 'deploy'
    if (body.status === 'success' && ['deploy','inspect'].includes(kind) && !body.commitSha) throw new ApiError('Successful deployment or inspection must identify its commit', 400)
    if(body.status==='success'&&kind==='deploy'&&payload.commitSha&&body.commitSha!==payload.commitSha)throw new ApiError('Deployment commit does not match the requested rollback',400)
    if(body.status==='success'&&kind==='deploy'&&payload.securityGate&&!['passed','not_applicable','overridden'].includes(String(body.securityStatus)))throw new ApiError('Successful deployment must include its dependency security result',400)
    if(body.status==='success'&&kind==='deploy'&&body.securityStatus==='overridden'&&payload.securityGate?.off!==true)throw new ApiError('Deployment did not have a security override',400)
    let result: object | null = null
    const deploymentCancelled=kind==='deploy'&&job.cancel_requested&&body.status==='failed'&&(body.result as {cancelled?:boolean}|undefined)?.cancelled===true
    if(deploymentCancelled)result={cancelled:true}
    if (body.status === 'success' && kind === 'inspect') {
      try { result = cleanInspection(body.result) } catch (error) { throw new ApiError((error as Error).message,400) }
      if ((result as { commit: string }).commit !== body.commitSha) throw new ApiError('Inspection commit mismatch',400)
    } else if (body.status === 'success' && ['database','validate'].includes(kind)) {
      if ((body.result as { ok?: boolean } | undefined)?.ok !== true) throw new ApiError('Setup job must report a successful check',400)
      result = { ok: true }
    }
    if(body.status==='success' && kind==='infrastructure') {
      const value=body.result as Record<string,unknown>; if(value?.ok!==true || JSON.stringify(value).length>300000)throw new ApiError('Invalid infrastructure result',400); result=value
    }
    if(body.status==='success' && ['console','logs'].includes(kind)) {
      const value=body.result as {ok?:boolean;cwd?:unknown}
      if(value?.ok!==true || typeof value.cwd!=='string' || value.cwd.length>1024)throw new ApiError('Invalid console result',400)
      result={ok:true,cwd:value.cwd}
    }
    if(job.resource_action==='storage'&&payload.resource?.operation==='sync-env'&&result){const value=result as Record<string,unknown>;result={ok:value.ok===true,synced:value.synced===true,keys:Array.isArray(value.keys)?value.keys.filter(key=>typeof key==='string'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)):[],healthy:value.healthy===true}}
    const privateResult=job.resource_action==='storage'&&payload.resource?.operation!=='sync-env'&&result?encryptSecret(JSON.stringify(result)):null
    await client.query(`update remote_jobs set status=$2,log=$3,commit_sha=$4,report_sequence=$5,updated_at=now(),
      finished_at=case when $6 then now() else null end,payload_ciphertext=case when $6 then null else payload_ciphertext end,result=$7::jsonb,security_status=coalesce($8,security_status) where id=$1`,
    [id,deploymentCancelled||finished && job.cancel_requested && ['console','logs'].includes(kind)?'cancelled':body.status,log,body.commitSha || null,body.sequence,finished,JSON.stringify(privateResult?{ok:true,private:true}:result),kind==='deploy'&&['running','passed','failed','overridden','not_applicable'].includes(String(body.securityStatus))?body.securityStatus:null])
    if(privateResult)await client.query('update remote_jobs set result_private_ciphertext=$2 where id=$1',[id,privateResult])
    if (body.status === 'success' && kind === 'deploy') await client.query('update remote_apps set live_commit=$2,deployed_at=now() where id=$1', [job.app_id,body.commitSha])
    if (body.status === 'success' && kind === 'inspect') {
      const inspection = result as ReturnType<typeof cleanInspection>
      await client.query(`update remote_apps set inspection=$2::jsonb,project_type=coalesce(project_type,$3),
        install_cmd=case when inspection is null then $4 else install_cmd end,build_cmd=case when inspection is null then $5 else build_cmd end,
        start_cmd=case when inspection is null then $6 else start_cmd end,setup_step='runtime',setup_completed_at=null where id=$1`,
      [job.app_id,JSON.stringify(inspection),inspection.framework,inspection.commands.install_cmd,inspection.commands.build_cmd,inspection.commands.start_cmd])
    }
    if (finished && kind === 'database') await client.query(`update remote_apps set database_config=jsonb_set(database_config,'{status}',to_jsonb($2::text)),
      setup_decisions=setup_decisions||jsonb_build_object('database',case when $2='ready' then 'configured' else 'pending' end),setup_completed_at=null where id=$1`,[job.app_id,body.status === 'success' ? 'ready' : 'failed'])
    if (body.status === 'success' && kind === 'validate') await client.query("update remote_apps set setup_completed_at=now(),setup_step='review' where id=$1",[job.app_id])
    if(body.status==='success'&&job.resource_action==='app-remove') await (await import('@/lib/application-removal')).finishApplicationRemoval(client,serverId,job,payload,result as Record<string,unknown>)
    else if(finished&&job.resource_action==='storage')await (await import('@/lib/remote-storage')).finishStorageOperation(client,serverId,job,payload,body.status==='success',result as Record<string,unknown>|null)
    else if(finished&&job.resource_action)await (await import('@/lib/remote-automation')).finishResource(client,serverId,job,payload,body.status==='success',result)
    await client.query('commit')
    return { ok: true, cancelRequested:job.cancel_requested===true }
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
}

export async function cancelQueuedJob(serverId: string, jobId: string, userId: string) {
  await ensureManagedServers()
  const result = await query(`update remote_jobs j set cancel_requested=true,
    status=case when j.status='queued' then 'cancelled' else j.status end,
    payload_ciphertext=case when j.status='queued' then null else j.payload_ciphertext end,
    finished_at=case when j.status='queued' then now() else j.finished_at end,updated_at=now()
    from managed_servers s where j.id=$1 and j.server_id=$2 and s.id=j.server_id and j.kind='deploy' and j.operation_type is null
      and (j.status='queued' or j.status='running' and s.metrics->'capabilities' ? 'application-control-v1') returning j.id`, [uuid(jobId),uuid(serverId)])
  if (!result.rowCount) throw new ApiError('This deployment has finished, or its agent must be updated before a running deployment can be cancelled', 409)
  await audit(userId, 'remote.deploy.cancel', jobId, { serverId })
  return { ok: true }
}
