import { Client, type SFTPWrapper } from 'ssh2'
import type { PoolClient } from 'pg'
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { isIP } from 'node:net'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { db } from '@/lib/db'
import { ApiError } from '@/lib/api'
import { audit } from '@/lib/audit'
import { changeServer, ensureManagedServers, uuid } from '@/lib/managed-servers'
import { redact } from '@/scripts/manager-agent.cjs'

export interface SshTarget { host: string; port: number; username: string }
type Asset = { url: string; sha256: string }
type Downloads = { node: Asset; caddy: Asset; git?: Asset; pm2Version: string }
const active = ((globalThis as unknown as { __remoteSetup?: Set<string> }).__remoteSetup ??= new Set<string>())

export function sshTarget(body: Record<string, unknown>): SshTarget {
  const host = typeof body.host === 'string' ? body.host.trim().replace(/^\[|\]$/g, '') : ''
  const port = body.port === undefined || body.port === '' ? 22 : Number(body.port)
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  if (!host || host.length > 253 || (!isIP(host) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host))) throw new ApiError('Enter a server IP address or hostname', 400)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiError('Invalid SSH port', 400)
  if (!username || username.length > 128 || /[\x00-\x1f]/.test(username)) throw new ApiError('Enter an SSH username', 400)
  return { host, port, username }
}

export const fingerprint = (key: Buffer) => 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
const psQuote = (value: string) => "'" + value.replace(/'/g, "''") + "'"
const shQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"
export const powershell = (script: string) => 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64')

export async function probeSsh(target: SshTarget) {
  return new Promise<{ fingerprint: string }>((resolve, reject) => {
    const connection = new Client()
    let observed = '', finished = false
    const finish = (error?: Error) => {
      if (finished) return; finished = true; connection.end()
      if (observed) resolve({ fingerprint: observed })
      else reject(new ApiError(error?.message || 'SSH did not present a host key', 400))
    }
    connection.on('error', finish).on('close', () => finish())
    // Never send a password during discovery: stop at the SSH host-key handshake.
    connection.connect({ ...target, readyTimeout: 15000, hostVerifier: (key: Buffer) => { observed = fingerprint(key); return false } })
  })
}

export async function connectSsh(target: SshTarget, password: string, expected: string) {
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(expected)) throw new ApiError('Check and accept the SSH fingerprint first', 400)
  return new Promise<Client>((resolve, reject) => {
    const connection = new Client()
    let mismatch = false, settled = false
    const onError = (error: Error) => {
      if (settled) return; settled = true; connection.end()
      reject(new ApiError(mismatch ? 'SSH host key changed. Check the server identity before reconnecting.' : `SSH connection failed: ${redact(error.message,[password])}`, 400))
    }
    const onClose = () => onError(new Error('Connection closed before authentication completed'))
    connection.on('error', onError).once('close', onClose).once('ready', () => {
      if (settled) return; settled = true; connection.removeListener('close', onClose); resolve(connection)
    })
    connection.connect({ ...target, password, readyTimeout: 20000, keepaliveInterval: 15000, keepaliveCountMax: 3,
      hostVerifier: (key: Buffer) => { const match = fingerprint(key) === expected; mismatch = !match; return match } })
  })
}

export function sshExec(connection: Client, command: string, input = '', timeout = 30000, log?: (text: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '', settled = false
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); connection.removeListener('close', closed)
      if (error) reject(error); else resolve(output)
    }
    const closed = () => finish(new Error('SSH connection closed before setup completed. Inspect the target before retrying.'))
    connection.once('close', closed)
    const timer = setTimeout(() => { finish(new Error('SSH setup exceeded its time limit. Inspect the target before retrying.')); connection.end() }, timeout)
    connection.exec(command, (error, stream) => {
      if (error) { finish(error); return }
      const append = (chunk: Buffer) => { const value = chunk.toString('utf8'); output = (output + value).slice(-120000); log?.(value) }
      stream.on('data', append); stream.stderr.on('data', append)
      stream.on('error', finish).on('close', (code: number) => finish(code === 0 ? undefined : new Error(`Remote command failed (${code}). ${output.slice(-2000)}`)))
      stream.end(input)
    })
  })
}

async function officialJson(url: string) {
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Manager-remote-setup' }, signal: AbortSignal.timeout(20000), redirect: 'error' })
  if (!response.ok) throw new ApiError('Could not obtain verified installer versions. Check Manager internet access or use manual enrollment.', 502)
  return response.json()
}
function releaseAsset(release: { assets: { name: string; browser_download_url: string; digest: string }[] }, pattern: RegExp, repository: string): Asset {
  const asset = release.assets.find(a => pattern.test(a.name))
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '') || !asset.browser_download_url.startsWith(`https://github.com/${repository}/releases/download/`)) throw new ApiError('The official installer does not have a verified SHA-256 digest; use manual enrollment', 502)
  return { url: asset.browser_download_url, sha256: asset.digest.slice(7) }
}
export async function installerDownloads(platform: string, arch: string): Promise<Downloads> {
  if (!['linux','win32'].includes(platform) || !['x64','arm64'].includes(arch) || (platform === 'win32' && arch !== 'x64')) throw new ApiError('Automatic setup supports Linux x64/ARM64 and Windows x64', 400)
  const response = await fetch('https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt', { signal: AbortSignal.timeout(20000), redirect: 'error' })
  if (!response.ok) throw new ApiError('Could not read official Node.js checksums', 502)
  const suffix = platform === 'win32' ? 'win-x64.zip' : `linux-${arch}.tar.xz`
  const line = (await response.text()).split('\n').map(s => s.trim().split(/\s+/)).find(parts => parts.length === 2 && parts[1].endsWith('-' + suffix))
  if (!line || !/^[a-f0-9]{64}$/.test(line[0]) || !/^node-v24\.\d+\.\d+-(?:linux-(?:x64|arm64)\.tar\.xz|win-x64\.zip)$/.test(line[1])) throw new ApiError('Invalid Node.js release manifest', 502)
  const [caddy, pm2] = await Promise.all([officialJson('https://api.github.com/repos/caddyserver/caddy/releases/latest'), officialJson('https://registry.npmjs.org/pm2/latest')])
  if (!/^\d+\.\d+\.\d+$/.test(pm2.version)) throw new ApiError('Invalid PM2 version', 502)
  const caddySuffix = platform === 'win32' ? 'windows_amd64.zip' : `linux_${arch === 'x64' ? 'amd64' : 'arm64'}.tar.gz`
  const version = line[1].match(/^node-(v24\.\d+\.\d+)-/)![1]
  return { node: { url: `https://nodejs.org/dist/${version}/${line[1]}`, sha256: line[0] },
    caddy: releaseAsset(caddy, new RegExp('^caddy_[0-9.]+_' + caddySuffix.replace(/\./g, '\\.') + '$'), 'caddyserver/caddy'),
    ...(platform === 'win32' ? { git: releaseAsset(await officialJson('https://api.github.com/repos/git-for-windows/git/releases/latest'), /^MinGit-[0-9.]+-64-bit\.zip$/, 'git-for-windows/git') } : {}), pm2Version: pm2.version }
}

async function bounded<T>(operation: Promise<T>, milliseconds = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('SSH file transfer timed out')), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
async function sftpSession(connection: Client) { return bounded(new Promise<SFTPWrapper>((resolve,reject) => connection.sftp((error,sftp) => error ? reject(error) : resolve(sftp)))) }
async function writeRemote(sftp: SFTPWrapper, filename: string, content: string) {
  return bounded(new Promise<void>((resolve,reject) => sftp.writeFile(filename,content,{ mode: 0o600 },error => error ? reject(error) : resolve())))
}
async function managerCa(input: unknown) {
  let pem = typeof input === 'string' ? input.trim() : ''
  if (!pem && process.platform === 'win32') pem = await readFile(path.join(process.env.ProgramData || 'C:\\ProgramData','Manager/caddy-data/caddy/pki/authorities/local/root.crt'),'utf8').catch(() => '')
  if (!pem) return ''
  try {
    if (pem.length > 8192 || pem.includes('PRIVATE KEY')) throw new Error()
    const certificate = new X509Certificate(pem)
    if (!certificate.ca) throw new Error()
    return certificate.toString()
  } catch { throw new ApiError('Supply a public root CA certificate in PEM format', 400) }
}

export async function setupServerSsh(serverId: string, body: Record<string, unknown>, userId: string) {
  await ensureManagedServers(); uuid(serverId)
  const target = sshTarget(body)
  const password = typeof body.password === 'string' ? body.password : ''
  if (!password || password.length > 4096 || /[\r\n\0]/.test(password)) throw new ApiError('Enter an SSH password without line breaks', 400)
  const manager = typeof body.manager === 'string' ? body.manager.replace(/\/$/,'') : ''
  if (!/^https:\/\/[a-z0-9.[\]:-]+$/i.test(manager)) throw new ApiError('Use a Manager HTTPS address reachable from the target server', 400)
  if (body.acceptFingerprint !== true) throw new ApiError('Accept the verified server fingerprint before installing', 400)
  if (active.has(serverId) || active.size >= 2) throw new ApiError('A setup is already active. Wait for it to finish.', 409)
  active.add(serverId)
  let connection: Client | undefined, sftp: SFTPWrapper | undefined, stage = '', transcript = '', enrollmentToken = ''
  let lease: PoolClient | undefined
  const files: string[] = []
  const safeLog = (value: string) => { transcript = (transcript + value).slice(-120000) }
  const started = Date.now()
  try {
    lease = await db.connect()
    const lock = await lease.query("select pg_try_advisory_lock(hashtext('manager-ssh-setup'),hashtext($1)) as acquired", [serverId])
    if (!lock.rows[0].acquired) throw new ApiError('This server is already being set up', 409)
    const server = (await lease.query('select platform,enabled,enrolled_at from managed_servers where id=$1', [serverId])).rows[0]
    if (!server?.enabled || server.enrolled_at) throw new ApiError('SSH setup is only available for a pending server', 409)
    const ca = await managerCa(body.caPem)
    connection = await connectSsh(target,password,String(body.fingerprint || ''))
    safeLog('[setup] SSH host identity verified\n')
    let arch = '', privileged = false
    if (server.platform === 'win32') {
      const output = await sshExec(connection, powershell("$ErrorActionPreference='Stop'; $p=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); Write-Output ('MANAGER_PREFLIGHT='+(@{arch=$env:PROCESSOR_ARCHITECTURE;admin=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}|ConvertTo-Json -Compress))"))
      const info = JSON.parse(output.split(/\r?\n/).find(line => line.startsWith('MANAGER_PREFLIGHT='))?.slice(18) || '{}')
      if (!info.admin) throw new ApiError('Windows SSH must use an elevated administrator account', 400)
      arch = info.arch === 'AMD64' ? 'x64' : ''; privileged = true
    } else {
      const output = await sshExec(connection,"printf 'MANAGER_OS=%s\\nMANAGER_ARCH=%s\\nMANAGER_UID=%s\\n' \"$(uname -s)\" \"$(uname -m)\" \"$(id -u)\"; test -d /run/systemd/system")
      if (!output.includes('MANAGER_OS=Linux')) throw new ApiError('Selected Linux server did not report Linux with systemd', 400)
      arch = output.includes('MANAGER_ARCH=x86_64') ? 'x64' : output.includes('MANAGER_ARCH=aarch64') ? 'arm64' : ''
      privileged = /MANAGER_UID=0(?:\r?\n|$)/.test(output)
      if (!privileged) await sshExec(connection,"sudo -S -p '' -- true",password+'\n')
    }
    safeLog('[setup] Operating system and administrator access checked\n')
    const downloads = await installerDownloads(server.platform,arch)
    const enrollment = await changeServer(serverId,'enrollment',userId)
    enrollmentToken = ('enrollmentToken' in enrollment ? enrollment.enrollmentToken : '') || ''
    sftp = await sftpSession(connection)
    const home = server.platform === 'win32' ? await bounded(new Promise<string>((resolve,reject) => sftp!.realpath('.',(err,value) => err ? reject(err) : resolve(value)))) : '/tmp'
    stage = path.posix.join(home.replace(/\\/g,'/'),'manager-setup-'+randomUUID())
    await bounded(new Promise<void>((resolve,reject) => sftp!.mkdir(stage,{ mode: 0o700 },error => error ? reject(error) : resolve())))
    const windowsStage = stage.replace(/^\/([A-Za-z]:\/)/,'$1').replace(/\//g,'\\')
    if (server.platform === 'win32') await sshExec(connection,powershell(`$ErrorActionPreference='Stop'; $p=${psQuote(windowsStage)}; $account=[Security.Principal.WindowsIdentity]::GetCurrent().Name; & icacls.exe $p /inheritance:r /grant:r ($account+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'; if($LASTEXITCODE -ne 0){exit 1}`))
    const write = async (name: string, content: string) => { files.push(path.posix.join(stage,name)); await writeRemote(sftp!,path.posix.join(stage,name),content) }
    await write('manager-agent.cjs',await readFile(path.join(process.cwd(),'scripts/manager-agent.cjs'),'utf8'))
    await write('manager-agent-supervisor.cjs',await readFile(path.join(process.cwd(),'scripts/manager-agent-supervisor.cjs'),'utf8'))
    await write('enrollment.json',JSON.stringify({ manager,serverId,enrollmentToken }))
    if (ca) await write('manager-ca.crt',ca)
    const installer = server.platform === 'win32' ? 'bootstrap-remote-agent.ps1' : 'bootstrap-remote-agent.sh'
    await write(installer,(await readFile(path.join(process.cwd(),'scripts',installer),'utf8')).replace(/\r\n/g,'\n'))
    if (server.platform === 'win32') await write('downloads.json',JSON.stringify(downloads))
    else await write('downloads.env',Object.entries({NODE_URL:downloads.node.url,NODE_SHA:downloads.node.sha256,CADDY_URL:downloads.caddy.url,CADDY_SHA:downloads.caddy.sha256,PM2_VERSION:downloads.pm2Version}).map(([key,value])=>`${key}=${shQuote(value)}`).join('\n'))
    await audit(userId,'server.ssh.setup.start',serverId,{host:target.host,port:target.port,username:target.username,fingerprint:body.fingerprint})
    const command = server.platform === 'win32' ? powershell(`& ${psQuote(windowsStage+'\\'+installer)}`) : `${privileged ? '' : "sudo -S -p '' -- "}/bin/bash ${shQuote(stage+'/'+installer)}`
    await sshExec(connection,command,server.platform === 'linux' && !privileged ? password+'\n' : '',20*60*1000,safeLog)
    let online = false
    for (let attempt = 0; attempt < 15; attempt++) {
      const row = (await lease.query('select last_seen_at,metrics from managed_servers where id=$1',[serverId])).rows[0]
      if (row?.metrics && new Date(row.last_seen_at).getTime() >= started) { online = true; break }
      await new Promise(resolve => setTimeout(resolve,2000))
    }
    await audit(userId,'server.ssh.setup.finish',serverId,{host:target.host,online})
    return { online, log: redact(transcript,[password,enrollmentToken]), message: online ? 'Agent installed and reporting to Manager.' : 'Setup finished; no monitoring heartbeat yet. Check the startup service on the target.' }
  } catch (error) {
    await audit(userId,'server.ssh.setup.failed',serverId,{host:target.host})
    throw new ApiError(redact((error as Error).message,[password,enrollmentToken]), error instanceof ApiError ? error.status : 400)
  } finally {
    if (sftp) {
      await bounded((async () => {
        for (const file of files) await new Promise<void>(resolve => sftp!.unlink(file,() => resolve()))
        if (stage) await new Promise<void>(resolve => sftp!.rmdir(stage,() => resolve()))
      })(), 3000).catch(() => {})
      sftp.end()
    }
    connection?.end()
    if (lease) { await lease.query("select pg_advisory_unlock(hashtext('manager-ssh-setup'),hashtext($1))",[serverId]).catch(() => {}); lease.release() }
    active.delete(serverId)
  }
}
