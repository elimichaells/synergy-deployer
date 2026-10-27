import { createHash, randomBytes, X509Certificate } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { db, query } from '@/lib/db'
import { ApiError } from '@/lib/api'
import { audit } from '@/lib/audit'
import { decryptSecret, encryptSecret } from '@/lib/secret-crypto'
import { getGitConnection, getGitHubConnectionToken } from '@/lib/github-connections'
import { repositoryPath } from '@/lib/git-provider-policy'
import { validateApp, sanitizeMetrics, redact, PROTOCOL_VERSION, databaseEnvironment, jobSecrets } from '@/scripts/manager-agent.cjs'
import { cleanInspection, REMOTE_SETUP_CAPABILITY } from '@/lib/remote-setup-policy'
import type { ManagedServer, RemoteApp } from './managed-server-types'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const token = () => randomBytes(32).toString('base64url')
const serverColumns = `s.id,s.name,s.location,s.platform,s.enabled,s.enrolled_at,s.last_seen_at,s.metrics,
  (s.ca_pem is not null) as has_ca,
  (select count(*)::int from remote_apps a where a.server_id=s.id) as app_count`
const appColumns = `id,server_id,name,repo_url,branch,install_cmd,build_cmd,start_cmd,port,health_path,
  access_mode,hostname,ip_address,ip_port,git_connection_id,env_names,live_commit,deployed_at,
  environment_name,production_id,project_type,guided_setup,setup_step,setup_completed_at`
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

export async function serverDetail(id: string) {
  await ensureManagedServers()
  const result = await query<ManagedServer>(`select ${serverColumns} from managed_servers s where s.id=$1`, [uuid(id)])
  if (!result.rows[0]) throw new ApiError('Server not found', 404)
  const [apps, jobs] = await Promise.all([
    query<RemoteApp>(`select ${appColumns} from remote_apps where server_id=$1 order by name`, [id]),
    query(`select j.id,j.app_id,a.name as app_name,j.kind,j.status,j.log,j.commit_sha,j.created_at,j.started_at,j.finished_at,j.updated_at
      from remote_jobs j join remote_apps a on a.id=j.app_id where j.server_id=$1 and j.kind='deploy' order by j.created_at desc limit 30`, [id]),
  ])
  return { server: status(result.rows[0]), apps: apps.rows, jobs: jobs.rows }
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
    const server = await client.query('select id from managed_servers where id=$1 and enabled=true for update', [serverId])
    if (!server.rowCount) throw new ApiError('Server is revoked or missing', 409)
    if (appId && (await client.query('select id from remote_apps where id=$1 and server_id=$2 and guided_setup=true', [appId,serverId])).rowCount) throw new ApiError('Use guided setup to change this application', 409)
    if (appId && (await client.query("select id from remote_jobs where app_id=$1 and status in ('queued','running')", [appId])).rowCount) throw new ApiError('Wait for the active deployment before editing this app', 409)
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
    await client.query('commit')
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  await audit(userId, appId ? 'remote.app.update' : 'remote.app.create', savedId, { serverId })
  return { id: savedId }
}

export async function queueRemoteDeploy(serverId: string, appId: string, userId: string) {
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
    if (app.guided_setup && !app.setup_completed_at) throw new ApiError('Complete guided setup and server checks before deploying this environment', 409)
    if (app.guided_setup && !server.metrics?.capabilities?.includes(REMOTE_SETUP_CAPABILITY)) throw new ApiError('Update the agent before deploying this guided application',409)
    if ((await client.query("select id from remote_jobs where app_id=$1 and status in ('queued','running')", [appId])).rowCount) throw new ApiError('This app already has a queued or running deployment', 409)
    if (app.git_connection_id !== before.git_connection_id) throw new ApiError('Git connection changed. Retry deployment.', 409)
    if (connection) repositoryPath(app.repo_url, connection)
    const database = app.database_config?.status === 'ready' && app.database_ciphertext ? JSON.parse(decryptSecret(app.database_ciphertext)) : null
    const environment = { ...JSON.parse(decryptSecret(app.env_ciphertext)), ...(database ? databaseEnvironment(database) : {}) }
    const payload = { ...validateApp({ ...app, environment }), id: app.id, git, project_type: app.project_type, requiredCapability: app.guided_setup ? REMOTE_SETUP_CAPABILITY : null }
    const result = await client.query(`insert into remote_jobs (server_id,app_id,user_id,payload_ciphertext) values ($1,$2,$3,$4) returning id`,
      [serverId, appId, userId, encryptSecret(JSON.stringify(payload))])
    jobId = result.rows[0].id
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
    // One job per server. A disconnected claim remains assigned, NEVER automatically re-executed.
    let job = (await client.query("select * from remote_jobs where server_id=$1 and status='running'", [serverId])).rows[0]
    if (!job) job = (await client.query(`update remote_jobs set status='running',claim_token=$2,started_at=now(),updated_at=now()
      where id=(select id from remote_jobs where server_id=$1 and status='queued' and (kind='deploy' or $3) order by created_at limit 1)
      returning *`, [serverId, token(), server.rows[0].metrics?.capabilities?.includes(REMOTE_SETUP_CAPABILITY) === true])).rows[0]
    // An older agent must never execute a setup payload as a deployment, including after a downgrade.
    const payload = job ? JSON.parse(decryptSecret(job.payload_ciphertext)) : null
    const capable = !job || (job.kind === 'deploy' && !payload.requiredCapability) || server.rows[0].metrics?.capabilities?.includes(REMOTE_SETUP_CAPABILITY) === true
    const result = job && capable ? { id: job.id, kind: job.kind, claimToken: job.claim_token, payload } : null
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
    const job = (await client.query('select * from remote_jobs where id=$1 and server_id=$2 and claim_token=$3 for update', [id,serverId,body.claimToken])).rows[0]
    if (!job) throw new ApiError('Job does not belong to this agent', 404)
    if (job.status !== 'running' || Number(body.sequence) <= job.report_sequence) { await client.query('commit'); return { ok: true } }
    const payload = JSON.parse(decryptSecret(job.payload_ciphertext))
    const secrets = jobSecrets(payload)
    const log = redact(body.log, secrets)
    const finished = body.status !== 'running'
    const kind = job.kind || 'deploy'
    if (body.status === 'success' && ['deploy','inspect'].includes(kind) && !body.commitSha) throw new ApiError('Successful deployment or inspection must identify its commit', 400)
    let result: object | null = null
    if (body.status === 'success' && kind === 'inspect') {
      try { result = cleanInspection(body.result) } catch (error) { throw new ApiError((error as Error).message,400) }
      if ((result as { commit: string }).commit !== body.commitSha) throw new ApiError('Inspection commit mismatch',400)
    } else if (body.status === 'success' && ['database','validate'].includes(kind)) {
      if ((body.result as { ok?: boolean } | undefined)?.ok !== true) throw new ApiError('Setup job must report a successful check',400)
      result = { ok: true }
    }
    await client.query(`update remote_jobs set status=$2,log=$3,commit_sha=$4,report_sequence=$5,updated_at=now(),
      finished_at=case when $6 then now() else null end,payload_ciphertext=case when $6 then null else payload_ciphertext end,result=$7::jsonb where id=$1`,
    [id,body.status,log,body.commitSha || null,body.sequence,finished,JSON.stringify(result)])
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
    await client.query('commit')
    return { ok: true }
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
}

export async function cancelQueuedJob(serverId: string, jobId: string, userId: string) {
  await ensureManagedServers()
  const result = await query(`update remote_jobs set status='cancelled',payload_ciphertext=null,finished_at=now(),updated_at=now()
    where id=$1 and server_id=$2 and status='queued' returning id`, [uuid(jobId),uuid(serverId)])
  if (!result.rowCount) throw new ApiError('Only a job that has not started can be cancelled', 409)
  await audit(userId, 'remote.deploy.cancel', jobId, { serverId })
  return { ok: true }
}
