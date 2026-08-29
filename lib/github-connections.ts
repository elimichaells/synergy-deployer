import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import { ApiError } from '@/lib/api'
import { query } from '@/lib/db'
import { getSetting, updateSettings } from '@/lib/settings'

export interface GitHubConnection {
  id: string
  name: string
  account_login: string
  account_name: string | null
  avatar_url: string | null
  token_last_four: string
  token_scopes: string[]
  last_validated_at: string | null
  last_error: string | null
  project_count: number
  created_at: string
  updated_at: string
}

let schemaPromise: Promise<void> | null = null

export function ensureGitHubConnectionSchema() {
  if (!schemaPromise) {
    schemaPromise = query(`
      create table if not exists github_connections (
        id uuid primary key default gen_random_uuid(),
        name text unique not null,
        account_login text not null,
        account_name text,
        avatar_url text,
        token_ciphertext text not null,
        token_last_four text not null,
        token_scopes text[] not null default '{}',
        last_validated_at timestamptz,
        last_error text,
        created_by uuid references users(id) on delete set null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `).then(async () => {
      await query('alter table projects add column if not exists github_connection_id uuid references github_connections(id) on delete set null')
      await query('create index if not exists projects_github_connection_idx on projects (github_connection_id)')
    }).catch((error) => {
      schemaPromise = null
      throw error
    })
  }
  return schemaPromise
}

function encryptionKey() {
  const secret = process.env.GITHUB_CONNECTIONS_ENCRYPTION_KEY || process.env.JWT_SECRET
  if (!secret) throw new Error('GITHUB_CONNECTIONS_ENCRYPTION_KEY or JWT_SECRET must be configured')
  return createHash('sha256').update(`manager:github-connections:${secret}`).digest()
}

function encryptToken(token: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`
}

function decryptToken(value: string) {
  const [version, ivValue, tagValue, encryptedValue] = value.split(':')
  if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) throw new Error('Unsupported GitHub token encryption format')
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivValue, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8')
}

async function inspectToken(token: string) {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'DeployManager',
    },
    cache: 'no-store',
  })
  if (!response.ok) throw new ApiError(`GitHub rejected this token with HTTP ${response.status}`, 400)
  const account = await response.json() as { login: string; name?: string | null; avatar_url?: string | null }
  const scopes = (response.headers.get('x-oauth-scopes') || '').split(',').map((scope) => scope.trim()).filter(Boolean)
  return { account, scopes }
}

export async function listGitHubConnections() {
  await ensureGitHubConnectionSchema()
  const { rows } = await query<GitHubConnection>(
    `select c.id,c.name,c.account_login,c.account_name,c.avatar_url,c.token_last_four,c.token_scopes,
            c.last_validated_at,c.last_error,c.created_at,c.updated_at,count(p.id)::int as project_count
       from github_connections c
       left join projects p on p.github_connection_id=c.id
      group by c.id order by c.name asc`
  )
  return rows
}

export async function createGitHubConnection(name: string, token: string, createdBy?: string | null) {
  await ensureGitHubConnectionSchema()
  const trimmedName = name.trim()
  const trimmedToken = token.trim()
  if (!trimmedName || trimmedName.length > 80) throw new ApiError('Connection name is required and must be at most 80 characters', 400)
  if (!trimmedToken) throw new ApiError('GitHub token is required', 400)
  const { account, scopes } = await inspectToken(trimmedToken)
  try {
    const { rows } = await query<GitHubConnection>(
      `insert into github_connections
        (name,account_login,account_name,avatar_url,token_ciphertext,token_last_four,token_scopes,last_validated_at,created_by)
       values ($1,$2,$3,$4,$5,$6,$7,now(),$8) returning *`,
      [trimmedName, account.login, account.name || null, account.avatar_url || null, encryptToken(trimmedToken), trimmedToken.slice(-4), scopes, createdBy || null]
    )
    return rows[0]
  } catch (error) {
    if ((error as { code?: string })?.code === '23505') throw new ApiError('A GitHub connection with this name already exists', 409)
    throw error
  }
}

export async function updateGitHubConnection(id: string, input: { name?: string; token?: string }) {
  await ensureGitHubConnectionSchema()
  const { rows } = await query<{ id: string; name: string }>('select id,name from github_connections where id=$1', [id])
  if (!rows[0]) throw new ApiError('GitHub connection not found', 404)
  const name = input.name !== undefined ? input.name.trim() : rows[0].name
  if (!name || name.length > 80) throw new ApiError('Connection name is required and must be at most 80 characters', 400)

  if (input.token?.trim()) {
    const token = input.token.trim()
    const { account, scopes } = await inspectToken(token)
    await query(
      `update github_connections set name=$1,account_login=$2,account_name=$3,avatar_url=$4,
         token_ciphertext=$5,token_last_four=$6,token_scopes=$7,last_validated_at=now(),last_error=null,updated_at=now()
       where id=$8`,
      [name, account.login, account.name || null, account.avatar_url || null, encryptToken(token), token.slice(-4), scopes, id]
    )
  } else {
    await query('update github_connections set name=$1,updated_at=now() where id=$2', [name, id])
  }
  return (await listGitHubConnections()).find((connection) => connection.id === id)
}

export async function testGitHubConnection(id: string) {
  await ensureGitHubConnectionSchema()
  const token = await getGitHubConnectionToken(id, false)
  try {
    const result = await inspectToken(token)
    await query(
      'update github_connections set account_login=$1,account_name=$2,avatar_url=$3,token_scopes=$4,last_validated_at=now(),last_error=null,updated_at=now() where id=$5',
      [result.account.login, result.account.name || null, result.account.avatar_url || null, result.scopes, id]
    )
    return { healthy: true, accountLogin: result.account.login, scopes: result.scopes }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'GitHub connection failed'
    await query('update github_connections set last_error=$1,updated_at=now() where id=$2', [message.slice(0, 1000), id])
    throw error
  }
}

export async function deleteGitHubConnection(id: string) {
  await ensureGitHubConnectionSchema()
  const { rows } = await query<{ count: number }>('select count(*)::int as count from projects where github_connection_id=$1', [id])
  if ((rows[0]?.count || 0) > 0) throw new ApiError('Reassign projects before removing this GitHub connection', 409)
  const result = await query('delete from github_connections where id=$1', [id])
  if (!result.rowCount) throw new ApiError('GitHub connection not found', 404)
}

export async function getGitHubConnectionToken(connectionId?: string | null, allowLegacy = true) {
  await ensureGitHubConnectionSchema()
  if (connectionId) {
    const { rows } = await query<{ token_ciphertext: string }>('select token_ciphertext from github_connections where id=$1', [connectionId])
    if (!rows[0]) throw new ApiError('The project GitHub connection no longer exists', 409)
    return decryptToken(rows[0].token_ciphertext)
  }
  if (allowLegacy) return getSetting('GITHUB_TOKEN')
  throw new ApiError('GitHub connection not found', 404)
}

export async function migrateLegacyGitHubConnection() {
  await ensureGitHubConnectionSchema()
  const { rows } = await query<{ count: number }>('select count(*)::int as count from github_connections')
  const token = await getSetting('GITHUB_TOKEN')
  if (!token) return null
  if ((rows[0]?.count || 0) > 0) {
    const { rows: projectRows } = await query<{ count: number }>(
      'select count(*)::int as count from projects where github_connection_id is null'
    )
    if ((projectRows[0]?.count || 0) === 0) await updateSettings({ GITHUB_TOKEN: '' })
    return null
  }
  const connection = await createGitHubConnection('Default GitHub', token)
  await query('update projects set github_connection_id=$1 where github_connection_id is null', [connection.id])
  await updateSettings({ GITHUB_TOKEN: '' })
  return connection
}
