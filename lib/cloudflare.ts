import { ApiError } from '@/lib/api'
import { query } from '@/lib/db'
import { decryptSecret, encryptSecret } from '@/lib/secret-crypto'
import { removeFromCaddyStrict, updateCaddyStrict } from '@/lib/caddy'
import { isIP } from 'node:net'

const API_BASE = 'https://api.cloudflare.com/client/v4'

export interface CloudflareConnection {
  id: string
  name: string
  token_last_four: string
  token_status: string
  last_error: string | null
  last_validated_at: string | null
  domain_count: number
  created_at: string
  updated_at: string
}

interface SecretCloudflareConnection extends CloudflareConnection { token_ciphertext: string }

export interface CloudflareZone {
  id: string
  name: string
  status: string
  paused: boolean
  connection_id: string
  connection_name: string
}

export interface ProjectDomain {
  id: string
  project_id: string
  project_name: string
  environment: string
  project_port: number
  hostname: string
  cloudflare_connection_id: string | null
  cloudflare_connection_name: string | null
  cloudflare_zone_id: string | null
  cloudflare_record_id: string | null
  record_type: 'A' | 'AAAA' | 'CNAME'
  record_content: string | null
  proxied: boolean
  is_primary: boolean
  ssl_mode: 'off' | 'flexible' | 'full' | 'strict' | null
  dns_status: string
  ssl_status: string
  last_error: string | null
  last_synced_at: string | null
  created_at: string
  updated_at: string
}

let schemaPromise: Promise<void> | null = null

export function ensureCloudflareSchema() {
  if (!schemaPromise) {
    schemaPromise = query(`
      create table if not exists cloudflare_connections (
        id uuid primary key default gen_random_uuid(), name text unique not null,
        token_ciphertext text not null, token_last_four text not null,
        token_status text not null default 'active', last_error text, last_validated_at timestamptz,
        created_by uuid references users(id) on delete set null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now()
      );
      create table if not exists project_domains (
        id uuid primary key default gen_random_uuid(), project_id uuid not null references projects(id) on delete cascade,
        hostname text unique not null, cloudflare_connection_id uuid references cloudflare_connections(id) on delete set null,
        cloudflare_zone_id text, cloudflare_record_id text,
        record_type text not null default 'A' check (record_type in ('A', 'AAAA', 'CNAME')),
        record_content text, proxied boolean not null default true, is_primary boolean not null default false,
        ssl_mode text check (ssl_mode in ('off', 'flexible', 'full', 'strict')),
        dns_status text not null default 'pending', ssl_status text not null default 'pending',
        last_error text, last_synced_at timestamptz,
        created_by uuid references users(id) on delete set null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now()
      );
      create index if not exists project_domains_project_idx on project_domains (project_id);
      create index if not exists project_domains_cloudflare_idx on project_domains (cloudflare_connection_id);
      create unique index if not exists project_domains_one_primary_idx on project_domains (project_id) where is_primary=true
    `).then(() => undefined).catch((error) => { schemaPromise = null; throw error })
  }
  return schemaPromise
}

async function cfRequest<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers || {}) },
    cache: 'no-store',
  })
  const body = await response.json().catch(() => ({})) as { success?: boolean; result?: T; errors?: Array<{ message?: string }> }
  if (!response.ok || body.success === false) {
    throw new ApiError(body.errors?.map((item) => item.message).filter(Boolean).join('; ') || `Cloudflare API returned ${response.status}`, 400)
  }
  return body.result as T
}

async function secretConnection(id: string) {
  await ensureCloudflareSchema()
  const { rows } = await query<SecretCloudflareConnection & { domain_count: number }>(
    `select cc.*,count(pd.id)::int as domain_count from cloudflare_connections cc
     left join project_domains pd on pd.cloudflare_connection_id=cc.id where cc.id=$1 group by cc.id`, [id]
  )
  if (!rows[0]) throw new ApiError('Cloudflare connection not found', 404)
  return rows[0]
}

export async function listCloudflareConnections() {
  await ensureCloudflareSchema()
  const { rows } = await query<CloudflareConnection>(
    `select cc.id,cc.name,cc.token_last_four,cc.token_status,cc.last_error,cc.last_validated_at,
            cc.created_at,cc.updated_at,count(pd.id)::int as domain_count
       from cloudflare_connections cc left join project_domains pd on pd.cloudflare_connection_id=cc.id
      group by cc.id order by cc.name`
  )
  return rows
}

export async function createCloudflareConnection(nameValue: unknown, tokenValue: unknown, createdBy?: string | null) {
  await ensureCloudflareSchema()
  const name = typeof nameValue === 'string' ? nameValue.trim() : ''
  const token = typeof tokenValue === 'string' ? tokenValue.trim() : ''
  if (!name || !token) throw new ApiError('Connection name and API token are required', 400)
  const verification = await cfRequest<{ id: string; status: string }>(token, '/user/tokens/verify')
  if (verification.status !== 'active') throw new ApiError('Cloudflare API token is not active', 400)
  try {
    const { rows } = await query<{ id: string }>(
      `insert into cloudflare_connections
        (name,token_ciphertext,token_last_four,token_status,last_validated_at,created_by)
       values ($1,$2,$3,'active',now(),$4) returning id`,
      [name, encryptSecret(token), token.slice(-4), createdBy || null]
    )
    return (await listCloudflareConnections()).find((item) => item.id === rows[0].id)
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new ApiError('A Cloudflare connection with this name already exists', 409)
    throw error
  }
}

export async function testCloudflareConnection(id: string) {
  const connection = await secretConnection(id)
  const token = decryptSecret(connection.token_ciphertext)
  try {
    const result = await cfRequest<{ status: string }>(token, '/user/tokens/verify')
    await query(`update cloudflare_connections set token_status=$2,last_error=null,last_validated_at=now(),updated_at=now() where id=$1`, [id, result.status])
    return { ok: result.status === 'active', status: result.status }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Token validation failed'
    await query(`update cloudflare_connections set token_status='invalid',last_error=$2,last_validated_at=now(),updated_at=now() where id=$1`, [id, message])
    throw error
  }
}

export async function deleteCloudflareConnection(id: string) {
  const connection = await secretConnection(id)
  if (connection.domain_count > 0) throw new ApiError('Remove or reassign managed domains before deleting this connection', 409)
  await query('delete from cloudflare_connections where id=$1', [id])
}

export async function listCloudflareZones(connectionId?: string) {
  const connections = connectionId ? [await secretConnection(connectionId)] : await Promise.all((await listCloudflareConnections()).map((item) => secretConnection(item.id)))
  const zones: CloudflareZone[] = []
  for (const connection of connections) {
    const token = decryptSecret(connection.token_ciphertext)
    const result = await cfRequest<Array<{ id: string; name: string; status: string; paused: boolean }>>(token, '/zones?per_page=50')
    zones.push(...result.map((zone) => ({ ...zone, connection_id: connection.id, connection_name: connection.name })))
  }
  return zones.sort((a, b) => a.name.localeCompare(b.name))
}

async function getZone(connection: SecretCloudflareConnection, hostname: string) {
  const token = decryptSecret(connection.token_ciphertext)
  const zones = await cfRequest<Array<{ id: string; name: string; status: string; paused: boolean }>>(token, '/zones?per_page=50')
  const zone = zones.filter((item) => hostname === item.name || hostname.endsWith(`.${item.name}`)).sort((a, b) => b.name.length - a.name.length)[0]
  if (!zone) throw new ApiError(`No accessible Cloudflare zone contains ${hostname}`, 400)
  return { zone, token }
}

function hostname(value: unknown) {
  const name = typeof value === 'string' ? value.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/\.$/, '') : ''
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name)) throw new ApiError('Enter a valid public hostname', 400)
  return name
}

async function zoneSsl(token: string, zoneId: string) {
  const setting = await cfRequest<{ id: string; value: 'off' | 'flexible' | 'full' | 'strict'; editable: boolean }>(token, `/zones/${zoneId}/settings/ssl`)
  return setting.value
}

export async function listProjectDomains(projectId?: string) {
  await ensureCloudflareSchema()
  const params = projectId ? [projectId] : []
  const where = projectId ? 'where pd.project_id=$1' : ''
  const { rows } = await query<ProjectDomain>(
    `select pd.*,p.name as project_name,p.environment,p.port as project_port,cc.name as cloudflare_connection_name
       from project_domains pd join projects p on p.id=pd.project_id
       left join cloudflare_connections cc on cc.id=pd.cloudflare_connection_id
       ${where} order by pd.hostname`, params
  )
  return rows
}

export async function createProjectDomain(projectId: string, input: Record<string, unknown>, createdBy?: string | null) {
  await ensureCloudflareSchema()
  const name = hostname(input.hostname)
  const manual = input.mode === 'manual'
  const { rows } = await query<{ name: string; port: number | null }>('select name,port from projects where id=$1', [projectId])
  const project = rows[0]
  if (!project) throw new ApiError('Project not found', 404)
  if (!project.port) throw new ApiError('Assign an application port before configuring a domain', 400)
  const conflict = await query(`select id from project_domains where hostname=$1 union all select id from projects where id<>$2 and lower(regexp_replace(regexp_replace(url, '^https?://', ''), '/.*$', ''))=$1`, [name, projectId])
  if (conflict.rows.length) throw new ApiError('This hostname is already assigned. Manage the existing domain instead.', 409)
  const type = String(input.recordType || 'A').toUpperCase()
  if (!['A', 'AAAA', 'CNAME'].includes(type)) throw new ApiError('Unsupported DNS record type', 400)
  const content = typeof input.recordContent === 'string' ? input.recordContent.trim() : ''
  if (!content) throw new ApiError('DNS record target is required', 400)
  if ((type === 'A' && isIP(content) !== 4) || (type === 'AAAA' && isIP(content) !== 6)) throw new ApiError(`A valid ${type === 'A' ? 'IPv4' : 'IPv6'} address is required`, 400)
  if (type === 'CNAME') hostname(content)
  const proxied = input.proxied !== false
  const isPrimary = input.isPrimary === true
  if (manual) {
    // Manual mode never calls Cloudflare. Caddy validates the complete shared configuration.
    await updateCaddyStrict(name, project.port)
    if (isPrimary) await query('update project_domains set is_primary=false,updated_at=now() where project_id=$1', [projectId])
    const { rows: inserted } = await query<{ id: string }>(`insert into project_domains
      (project_id,hostname,record_type,record_content,proxied,is_primary,dns_status,ssl_status,created_by)
      values($1,$2,$3,$4,false,$5,'manual','pending',$6) returning id`, [projectId, name, type, content, isPrimary, createdBy || null])
    if (isPrimary) await query('update projects set url=$2,updated_at=now() where id=$1', [projectId, `https://${name}`])
    return (await listProjectDomains(projectId)).find(item => item.id === inserted[0].id)
  }
  const connection = await secretConnection(String(input.cloudflareConnectionId || ''))
  const { zone, token } = await getZone(connection, name)

  const existing = await cfRequest<Array<{ id: string }>>(token, `/zones/${zone.id}/dns_records?type=${type}&name=${encodeURIComponent(name)}`)
  if (existing.length) throw new ApiError('This DNS record already exists in Cloudflare. Use manual DNS mode to retain it; Manager will not overwrite an unmanaged record.', 409)
  const payload = { type, name, content, ttl: 1, proxied, comment: `Managed by deployment Manager for ${project.name}` }
  const record = existing[0]
    ? await cfRequest<{ id: string }>(token, `/zones/${zone.id}/dns_records/${existing[0].id}`, { method: 'PATCH', body: JSON.stringify(payload) })
    : await cfRequest<{ id: string }>(token, `/zones/${zone.id}/dns_records`, { method: 'POST', body: JSON.stringify(payload) })

  try {
    await updateCaddyStrict(name, project.port)
    const sslMode = await zoneSsl(token, zone.id).catch(() => null)
    if (isPrimary) await query('update project_domains set is_primary=false,updated_at=now() where project_id=$1', [projectId])
    const { rows: inserted } = await query<{ id: string }>(
      `insert into project_domains
        (project_id,hostname,cloudflare_connection_id,cloudflare_zone_id,cloudflare_record_id,
         record_type,record_content,proxied,is_primary,ssl_mode,dns_status,ssl_status,last_synced_at,created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,now(),$12) returning id`,
      [projectId, name, connection.id, zone.id, record.id, type, content, proxied, isPrimary, sslMode, sslMode === 'strict' ? 'strict' : 'attention', createdBy || null]
    )
    if (isPrimary) await query('update projects set url=$2,updated_at=now() where id=$1', [projectId, `https://${name}`])
    return (await listProjectDomains(projectId)).find((item) => item.id === inserted[0].id)
  } catch (error) {
    if (!existing[0]) await cfRequest(token, `/zones/${zone.id}/dns_records/${record.id}`, { method: 'DELETE' }).catch(() => undefined)
    throw error
  }
}

export async function syncProjectDomain(id: string) {
  const { rows } = await query<ProjectDomain>('select pd.*,p.name as project_name,p.environment,p.port as project_port,null::text as cloudflare_connection_name from project_domains pd join projects p on p.id=pd.project_id where pd.id=$1', [id])
  const domain = rows[0]
  if (!domain) throw new ApiError('Domain not found', 404)
  if (!domain.cloudflare_connection_id || !domain.cloudflare_zone_id || !domain.cloudflare_record_id) throw new ApiError('Domain is not connected to Cloudflare', 400)
  const connection = await secretConnection(domain.cloudflare_connection_id)
  const token = decryptSecret(connection.token_ciphertext)
  try {
    const record = await cfRequest<{ id: string; content: string; proxied: boolean }>(token, `/zones/${domain.cloudflare_zone_id}/dns_records/${domain.cloudflare_record_id}`)
    const sslMode = await zoneSsl(token, domain.cloudflare_zone_id)
    await query(`update project_domains set record_content=$2,proxied=$3,ssl_mode=$4,dns_status='active',ssl_status=$5,last_error=null,last_synced_at=now(),updated_at=now() where id=$1`, [id, record.content, record.proxied, sslMode, sslMode === 'strict' ? 'strict' : 'attention'])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Cloudflare sync failed'
    await query(`update project_domains set dns_status='error',last_error=$2,last_synced_at=now(),updated_at=now() where id=$1`, [id, message])
    throw error
  }
  return (await listProjectDomains(domain.project_id)).find((item) => item.id === id)
}

export async function setZoneSslMode(connectionId: string, zoneId: string, mode: string) {
  if (!['off', 'flexible', 'full', 'strict'].includes(mode)) throw new ApiError('Invalid SSL mode', 400)
  const connection = await secretConnection(connectionId)
  const token = decryptSecret(connection.token_ciphertext)
  const setting = await cfRequest<{ id: string; value: string }>(token, `/zones/${zoneId}/settings/ssl`, { method: 'PATCH', body: JSON.stringify({ value: mode }) })
  await query(`update project_domains set ssl_mode=$3,ssl_status=$4,last_synced_at=now(),updated_at=now() where cloudflare_connection_id=$1 and cloudflare_zone_id=$2`, [connectionId, zoneId, mode, mode === 'strict' ? 'strict' : 'attention'])
  return setting
}

export async function deleteProjectDomain(id: string) {
  const { rows } = await query<ProjectDomain>('select pd.*,p.name as project_name,p.environment,p.port as project_port,null::text as cloudflare_connection_name from project_domains pd join projects p on p.id=pd.project_id where pd.id=$1', [id])
  const domain = rows[0]
  if (!domain) throw new ApiError('Domain not found', 404)
  await removeFromCaddyStrict(domain.hostname)
  if (domain.cloudflare_connection_id && domain.cloudflare_zone_id && domain.cloudflare_record_id) {
    const connection = await secretConnection(domain.cloudflare_connection_id)
    await cfRequest(decryptSecret(connection.token_ciphertext), `/zones/${domain.cloudflare_zone_id}/dns_records/${domain.cloudflare_record_id}`, { method: 'DELETE' })
  }
  await query('delete from project_domains where id=$1', [id])
  if (domain.is_primary) await query('update projects set url=null,updated_at=now() where id=$1', [domain.project_id])
}
