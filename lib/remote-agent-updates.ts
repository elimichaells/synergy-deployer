import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { db, query } from '@/lib/db'
import { ApiError } from '@/lib/api'
import { audit } from '@/lib/audit'
import { ensureManagedServers, uuid } from '@/lib/managed-servers'
import { AGENT_VERSION, UPDATE_CAPABILITY } from '@/scripts/manager-agent.cjs'

const active = "('queued','installing','recovery_required')"
const columns = 'id,from_version,target_version,status,message,created_at,started_at,finished_at,updated_at'
export function newerAgent(available: string, installed: string) {
  const parse = (s: string) => /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(s) ? s.split('.').map(Number) : null
  const a = parse(available), b = parse(installed)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}
export async function agentUpdateStatus(serverId: string) {
  await ensureManagedServers(); uuid(serverId)
  const server = (await query('select enabled,enrolled_at,metrics,last_seen_at from managed_servers where id=$1', [serverId])).rows[0]
  if (!server) throw new ApiError('Server not found', 404)
  const latest = (await query(`select ${columns} from remote_agent_updates where server_id=$1 order by created_at desc limit 1`, [serverId])).rows[0] || null
  return { installed: server.metrics?.version || null, available: AGENT_VERSION,
    supported: server.metrics?.capabilities?.includes(UPDATE_CAPABILITY) === true,
    updateAvailable: newerAgent(AGENT_VERSION, server.metrics?.version || ''), latest }
}
async function bundledAgent() {
  const source = await readFile(path.join(process.cwd(), 'scripts/manager-agent.cjs'), 'utf8')
  if (Buffer.byteLength(source) > 2_000_000 || !source.includes(`const AGENT_VERSION = '${AGENT_VERSION}';`)) throw new ApiError('Agent package does not match this Manager build', 503)
  return { source, sha256: createHash('sha256').update(source).digest('hex') }
}
export async function queueAgentUpdate(serverId: string, userId: string) {
  await ensureManagedServers(); uuid(serverId)
  const bundle = await bundledAgent()
  const client = await db.connect()
  let id: string
  try {
    await client.query('begin')
    const server = (await client.query('select * from managed_servers where id=$1 for update', [serverId])).rows[0]
    if (!server?.enabled || !server.enrolled_at) throw new ApiError('Connect an active server first', 409)
    if (!server.last_seen_at || Date.now() - new Date(server.last_seen_at).getTime() > 90_000) throw new ApiError('Wait for the server to reconnect before updating', 409)
    if (!server.metrics?.capabilities?.includes(UPDATE_CAPABILITY)) throw new ApiError('Enable the update supervisor on this server first. Enrollment and application data must be kept.', 409)
    if ((await client.query(`select id from remote_agent_updates where server_id=$1 and status in ${active}`, [serverId])).rowCount) throw new ApiError('An agent update is already active on this server', 409)
    if (!newerAgent(AGENT_VERSION, server.metrics.version)) throw new ApiError('No newer compatible agent is bundled with this Manager', 409)
    id = (await client.query(`insert into remote_agent_updates(server_id,user_id,from_version,target_version,sha256,source)
      values($1,$2,$3,$4,$5,$6) returning id`, [serverId,userId,server.metrics.version,AGENT_VERSION,bundle.sha256,bundle.source])).rows[0].id
    await client.query('commit')
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  await audit(userId, 'server.agent.update.queue', serverId, { id, version: AGENT_VERSION })
  return { id }
}
export async function cancelAgentUpdate(serverId: string, id: unknown, userId: string) {
  await ensureManagedServers(); uuid(serverId); uuid(id)
  const result = await query(`update remote_agent_updates set status='cancelled',message='Cancelled before installation',source=null,finished_at=now(),updated_at=now()
    where server_id=$1 and id=$2 and status='queued' returning id`, [serverId,id])
  if (!result.rowCount) throw new ApiError('Only an update that has not started can be cancelled', 409)
  await audit(userId, 'server.agent.update.cancel', serverId, { id })
  return { ok: true }
}
export async function claimAgentUpdate(serverId: string, body: Record<string, unknown>) {
  if (body.supervisorProtocol !== 1 || typeof body.version !== 'string') throw new ApiError('Compatible agent supervisor required', 409)
  const client = await db.connect()
  try {
    await client.query('begin')
    const server = (await client.query('select enabled,metrics from managed_servers where id=$1 for update', [serverId])).rows[0]
    if (!server?.enabled) throw new ApiError('Server revoked', 401)
    let job = (await client.query(`select * from remote_agent_updates where server_id=$1 and status in ${active}`, [serverId])).rows[0]
    if (job?.status === 'queued') {
      // The same server row lock serializes application claims and update claims.
      if ((await client.query("select id from remote_jobs where server_id=$1 and status='running'", [serverId])).rowCount) job = null
      else if (body.version !== job.from_version || !server.metrics?.capabilities?.includes(UPDATE_CAPABILITY)) throw new ApiError('Installed agent changed; cancel this queued update and check versions again', 409)
      else job = (await client.query(`update remote_agent_updates set status='installing',claim_token=$2,started_at=now(),updated_at=now(),message='Verifying the update and preserving the previous agent' where id=$1 and status='queued' returning *`, [job.id,randomBytes(32).toString('base64url')])).rows[0]
    }
    await client.query('commit')
    return { update: job ? { id:job.id, fromVersion:job.from_version, version:job.target_version, sha256:job.sha256, source:job.source, claimToken:job.claim_token, supervisorProtocol:1 } : null }
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
}
export async function reportAgentUpdate(serverId: string, body: Record<string, unknown>) {
  uuid(body.id)
  if (!['installing','success','rolled_back','failed','recovery_required'].includes(String(body.status)) || !Number.isSafeInteger(body.sequence) || Number(body.sequence) < 1) throw new ApiError('Invalid update report', 400)
  const client = await db.connect()
  try {
    await client.query('begin')
    // Lock ordering matches the claim path; heartbeat confirmation cannot race another update.
    const server = (await client.query('select metrics,last_seen_at from managed_servers where id=$1 for update', [serverId])).rows[0]
    const job = (await client.query('select * from remote_agent_updates where id=$1 and server_id=$2 and claim_token=$3 for update', [body.id,serverId,body.claimToken])).rows[0]
    if (!job) throw new ApiError('Update does not belong to this agent', 404)
    if (!['installing','recovery_required'].includes(job.status) || Number(body.sequence) <= Number(job.report_sequence)) { await client.query('commit'); return { ok:true } }
    if (['success','rolled_back'].includes(String(body.status))) {
      const expected = body.status === 'success' ? job.target_version : job.from_version
      if (server.metrics?.version !== expected || !server.last_seen_at || new Date(server.last_seen_at).getTime() < new Date(job.started_at).getTime() || Date.now()-new Date(server.last_seen_at).getTime()>90_000) throw new ApiError('Waiting for a fresh heartbeat from the expected agent version', 409)
    }
    const messages: Record<string,string> = { installing:'Installing and checking the agent connection', success:'Agent updated; enrollment and application state preserved', rolled_back:'Previous agent restored and reconnected', failed:'Update stopped before activation; existing agent retained', recovery_required:'Automatic recovery needs attention on this server; application jobs remain paused' }
    const terminal = !['installing','recovery_required'].includes(String(body.status))
    await client.query(`update remote_agent_updates set status=$2,report_sequence=$3,message=$4,updated_at=now(),
      finished_at=case when $5 then now() else null end,source=case when $5 then null else source end where id=$1`, [job.id,body.status,body.sequence,messages[String(body.status)],terminal])
    await client.query('commit')
    return { ok:true }
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
}
