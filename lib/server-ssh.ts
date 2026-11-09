import { Client, utils, type SFTPWrapper } from 'ssh2'
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
import { agentBundle } from '@/scripts/agent-bundle.cjs'
import { discoveryPaths, selectedTools, toolCompatible, verifyToolPlan } from '@/lib/server-discovery'
import { SERVER_TOOLS, type ServerToolId, type ServerInventory, type ToolCandidate } from '@/lib/server-tool-catalog'

export interface SshTarget { host: string; port: number; username: string }
export interface SshCredentials { method: 'password' | 'key'; password?: string; privateKey?: string; passphrase?: string; sudoPassword?: string }
export function sshCredentials(body: Record<string, unknown>): SshCredentials {
  const method = body.authentication ?? 'password'
  const secret = (value: unknown, label: string) => {
    if (value === undefined || value === '') return ''
    if (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value)) throw new ApiError(`Enter a valid ${label} without line breaks`,400)
    return value
  }
  if (method === 'password') {
    const password = secret(body.password,'SSH password')
    if (!password) throw new ApiError('Enter an SSH password',400)
    return { method, password, sudoPassword: password }
  }
  if (method !== 'key') throw new ApiError('Choose password or private-key authentication',400)
  if (typeof body.privateKey !== 'string' || !body.privateKey.trim() || body.privateKey.length > 16384 || body.privateKey.includes('\0')) throw new ApiError('Supply an SSH private key (up to 16 KB)',400)
  const privateKey = body.privateKey.trim() + '\n', passphrase = secret(body.passphrase,'key passphrase')
  const parsed = utils.parseKey(privateKey,passphrase || undefined)
  if (parsed instanceof Error || !parsed.isPrivateKey()) throw new ApiError('The private key could not be read. Check its format and passphrase.',400)
  return { method, privateKey, passphrase, sudoPassword: secret(body.sudoPassword,'sudo password') }
}
export const credentialSecrets = (auth: SshCredentials) => [auth.password,auth.privateKey,auth.passphrase,auth.sudoPassword,...(auth.privateKey?.split(/\r?\n/).filter(line => line.length > 10) || [])].filter((v): v is string => !!v)
export function sudoCommand(auth: SshCredentials) {
  return auth.sudoPassword ? { prefix: "sudo -S -p '' -- ", input: auth.sudoPassword+'\n' } : { prefix: 'sudo -n -- ', input: '' }
}
type Asset = { url: string; sha256: string }
type Downloads = { node?: Asset; caddy?: Asset; git?: Asset; pm2Version?: string }
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
    // Never authenticate during identity discovery: stop at the host-key handshake.
    connection.connect({ ...target, readyTimeout: 15000, hostVerifier: (key: Buffer) => { observed = fingerprint(key); return false } })
  })
}

export async function connectSsh(target: SshTarget, credentials: SshCredentials | string, expected: string) {
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(expected)) throw new ApiError('Check and accept the SSH fingerprint first', 400)
  const auth = typeof credentials === 'string' ? sshCredentials({password:credentials}) : credentials
  return new Promise<Client>((resolve, reject) => {
    const connection = new Client()
    let mismatch = false, settled = false
    const onError = (error: Error) => {
      if (settled) return; settled = true; connection.end()
      reject(new ApiError(mismatch ? 'SSH host key changed. Check the server identity before reconnecting.' : `SSH connection failed: ${redact(error.message,credentialSecrets(auth))}`, 400))
    }
    const onClose = () => onError(new Error('Connection closed before authentication completed'))
    connection.on('error', onError).once('close', onClose).once('ready', () => {
      if (settled) return; settled = true; connection.removeListener('close', onClose); resolve(connection)
    })
    connection.connect({ ...target, ...(auth.method === 'key' ? { privateKey: auth.privateKey, passphrase: auth.passphrase, authHandler: ['publickey'] as ['publickey'] } : { password: auth.password, authHandler: ['password'] as ['password'] }), readyTimeout: 20000, keepaliveInterval: 15000, keepaliveCountMax: 3,
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
export async function installerDownloads(platform: string, arch: string, needed = ['node','git','caddy','pm2']): Promise<Downloads> {
  if (!['linux','win32'].includes(platform) || !['x64','arm64'].includes(arch) || (platform === 'win32' && arch !== 'x64')) throw new ApiError('Automatic setup supports Linux x64/ARM64 and Windows x64', 400)
  const downloads: Downloads = {}
  if (needed.includes('node')) {
  const response = await fetch('https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt', { signal: AbortSignal.timeout(20000), redirect: 'error' })
  if (!response.ok) throw new ApiError('Could not read official Node.js checksums', 502)
  const suffix = platform === 'win32' ? 'win-x64.zip' : `linux-${arch}.tar.xz`
  const line = (await response.text()).split('\n').map(s => s.trim().split(/\s+/)).find(parts => parts.length === 2 && parts[1].endsWith('-' + suffix))
  if (!line || !/^[a-f0-9]{64}$/.test(line[0]) || !/^node-v24\.\d+\.\d+-(?:linux-(?:x64|arm64)\.tar\.xz|win-x64\.zip)$/.test(line[1])) throw new ApiError('Invalid Node.js release manifest', 502)
  const version = line[1].match(/^node-(v24\.\d+\.\d+)-/)![1]
  downloads.node = { url: `https://nodejs.org/dist/${version}/${line[1]}`, sha256: line[0] }
  }
  if (needed.includes('caddy')) {
    const suffix = platform === 'win32' ? 'windows_amd64.zip' : `linux_${arch === 'x64' ? 'amd64' : 'arm64'}.tar.gz`
    downloads.caddy = releaseAsset(await officialJson('https://api.github.com/repos/caddyserver/caddy/releases/latest'), new RegExp('^caddy_[0-9.]+_' + suffix.replace(/\./g, '\\.') + '$'), 'caddyserver/caddy')
  }
  if (needed.includes('pm2')) {
    const pm2 = await officialJson('https://registry.npmjs.org/pm2/latest')
    if (!/^\d+\.\d+\.\d+$/.test(pm2.version)) throw new ApiError('Invalid PM2 version', 502)
    downloads.pm2Version = pm2.version
  }
  if (needed.includes('git') && platform === 'win32') downloads.git = releaseAsset(await officialJson('https://api.github.com/repos/git-for-windows/git/releases/latest'), /^MinGit-[0-9.]+-64-bit\.zip$/, 'git-for-windows/git')
  return downloads
}

export function parseServerInventory(output: string, platform: string): ServerInventory {
  let raw: Record<string, unknown>
  if (platform === 'win32') {
    const line = output.split(/\r?\n/).find(line => line.startsWith('MANAGER_INVENTORY='))
    if (!line) throw new ApiError('Server inspection did not return an inventory', 400)
    raw = JSON.parse(line.slice('MANAGER_INVENTORY='.length))
  } else {
    const tools: Record<string, unknown[]> = {}, services: unknown[] = [], ports: number[] = []
    raw = { tools, services, ports, portsKnown: false }
    for (const line of output.split(/\r?\n/)) {
      const [kind, ...encoded] = line.split('\t'), values = encoded.map(value => Buffer.from(value, 'base64').toString('utf8'))
      if (kind === 'meta') Object.assign(raw, { platform: values[0] === 'Linux' ? 'linux' : '', arch: values[1], privileged: values[2] === '0' })
      if (kind === 'ports') raw.portsKnown = values[0] === 'known'
      if (kind === 'port') ports.push(Number(values[0]))
      if (kind === 'service') services.push({ name: values[0], status: values[1], executable: values[2], config: values[3] })
      if (kind === 'tool' && SERVER_TOOLS.some(tool => tool.id === values[0])) (tools[values[0]] ||= []).push({ path: values[1], version: values[2], error: values[3] })
    }
  }
  if (raw.platform !== platform || !['x64','arm64'].includes(String(raw.arch)) || platform === 'win32' && raw.arch !== 'x64') throw new ApiError('Server inspection returned an unsupported operating system or architecture',400)
  const clean = (value: unknown, max = 1024) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0,max) : ''
  const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : []
  const tools = Object.fromEntries(SERVER_TOOLS.map(tool => [tool.id, list((raw.tools as Record<string, unknown>)?.[tool.id]).slice(0,8).map(item => {
    const version = clean(item.version,200), error = clean(item.error,200)
    return { path: clean(item.path), version, compatible: !error && toolCompatible(tool.id, version), ...(error ? { error } : {}) }
  })])) as Record<ServerToolId, ToolCandidate[]>
  return { platform: platform as ServerInventory['platform'], arch: String(raw.arch), privileged: raw.privileged === true, portsKnown: raw.portsKnown === true,
    ports: [...new Set((Array.isArray(raw.ports) ? raw.ports : []).filter((n): n is number => Number.isInteger(n) && n > 0 && n <= 65535))], tools,
    services: list(raw.services).slice(0,100).map(item => ({ name: clean(item.name,200), status: clean(item.status,50), executable: clean(item.executable), config: clean(item.config) })) }
}

export async function inspectConnection(connection: Client, platform: string, paths: Partial<Record<ServerToolId, string>>) {
  const name = platform === 'win32' ? 'inspect-remote-server.ps1' : 'inspect-remote-server.sh'
  const source = (await readFile(path.join(process.cwd(),'scripts',name),'utf8')).replace(/\r\n/g,'\n')
  if (platform !== 'win32') return parseServerInventory(await sshExec(connection, '/bin/bash -s', source.replace('__MANAGER_PATHS__', () => Object.entries(paths).map(([id,p]) => `TOOL_${id}=${shQuote(p)}`).join('\n')),120000),platform)
  // Avoid Windows SSH command-line limits; only a protected temporary script is written.
  const sftp = await sftpSession(connection)
  let folder = '', file = ''
  try {
    const home = await bounded(new Promise<string>((resolve,reject) => sftp.realpath('.',(err,value) => err ? reject(err) : resolve(value))))
    folder = path.posix.join(home.replace(/\\/g,'/'),'manager-inspect-'+randomUUID())
    await bounded(new Promise<void>((resolve,reject) => sftp.mkdir(folder,{mode:0o700},error => error ? reject(error) : resolve())))
    const native = folder.replace(/^\/([A-Za-z]:\/)/,'$1').replace(/\//g,'\\')
    await sshExec(connection,powershell(`$p=${psQuote(native)}; $a=[Security.Principal.WindowsIdentity]::GetCurrent().Name; & icacls.exe $p /inheritance:r /grant:r ($a+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'; if($LASTEXITCODE -ne 0){exit 1}`))
    file = path.posix.join(folder,name)
    await writeRemote(sftp,file,source.replace('__MANAGER_PATHS__',() => JSON.stringify(paths).replace(/'/g,"''")))
    return parseServerInventory(await sshExec(connection,powershell(`& ${psQuote(native+'\\'+name)}`),'',120000),platform)
  } finally {
    if (file) await bounded(new Promise<void>(resolve => sftp.unlink(file,() => resolve()))).catch(()=>{})
    if (folder) await bounded(new Promise<void>(resolve => sftp.rmdir(folder,() => resolve()))).catch(()=>{})
    sftp.end()
  }
}

export async function inspectServerSsh(serverId: string, body: Record<string, unknown>, userId: string) {
  await ensureManagedServers(); uuid(serverId)
  const target = sshTarget(body), auth = sshCredentials(body)
  if (body.acceptFingerprint !== true) throw new ApiError('Accept the verified server fingerprint before inspecting',400)
  const { rows } = await db.query('select platform,enabled,enrolled_at from managed_servers where id=$1',[serverId])
  if (!rows[0]?.enabled || rows[0].enrolled_at) throw new ApiError('SSH discovery is available for pending servers',409)
  let paths: Partial<Record<ServerToolId, string>>
  try { paths = discoveryPaths(body.paths,rows[0].platform) }
  catch (error) { throw new ApiError((error as Error).message,400) }
  const connection = await connectSsh(target,auth,String(body.fingerprint || ''))
  try {
    const inventory = await inspectConnection(connection,rows[0].platform,paths)
    await audit(userId,'server.ssh.inspect',serverId,{host:target.host,platform:inventory.platform})
    return { inventory }
  } catch (error) { throw new ApiError(redact((error as Error).message,credentialSecrets(auth)),400) }
  finally { connection.end() }
}

async function bounded<T>(operation: Promise<T>, milliseconds = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('SSH file transfer timed out')), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
// Starting the Windows subsystem on a new account can outlast a small file
// transfer. Allow one minute to open it; individual transfers remain bounded.
export async function sftpSession(connection: Client) { return bounded(new Promise<SFTPWrapper>((resolve,reject) => connection.sftp((error,sftp) => error ? reject(error) : resolve(sftp))),60000) }
export async function writeRemote(sftp: SFTPWrapper, filename: string, content: string) {
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
  const auth = sshCredentials(body), sudo = sudoCommand(auth)
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
    const plan = selectedTools(body.tools,server.platform)
    if (body.reviewed !== true) throw new ApiError('Review the detected services and installation choices first',400)
    const ca = await managerCa(body.caPem)
    connection = await connectSsh(target,auth,String(body.fingerprint || ''))
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
      if (!privileged) {
        try { await sshExec(connection,sudo.prefix+'true',sudo.input) }
        catch { throw new ApiError('Linux setup needs root, passwordless sudo, or the optional sudo password.',400) }
      }
    }
    safeLog('[setup] Operating system and administrator access checked\n')
    const reuse = Object.fromEntries(Object.entries(plan).filter(([,item]) => item.mode === 'reuse').map(([id,item]) => [id,item.path]))
    const inventory = await inspectConnection(connection,server.platform,reuse)
    verifyToolPlan(plan,inventory)
    const installs = Object.entries(plan).filter(([,item]) => item.mode === 'install').map(([id]) => id)
    const downloads = await installerDownloads(server.platform,arch,installs)
    const enrollment = await changeServer(serverId,'enrollment',userId)
    enrollmentToken = ('enrollmentToken' in enrollment ? enrollment.enrollmentToken : '') || ''
    sftp = await sftpSession(connection)
    const home = server.platform === 'win32' ? await bounded(new Promise<string>((resolve,reject) => sftp!.realpath('.',(err,value) => err ? reject(err) : resolve(value)))) : '/tmp'
    stage = path.posix.join(home.replace(/\\/g,'/'),'manager-setup-'+randomUUID())
    await bounded(new Promise<void>((resolve,reject) => sftp!.mkdir(stage,{ mode: 0o700 },error => error ? reject(error) : resolve())))
    const windowsStage = stage.replace(/^\/([A-Za-z]:\/)/,'$1').replace(/\//g,'\\')
    if (server.platform === 'win32') await sshExec(connection,powershell(`$ErrorActionPreference='Stop'; $p=${psQuote(windowsStage)}; $account=[Security.Principal.WindowsIdentity]::GetCurrent().Name; & icacls.exe $p /inheritance:r /grant:r ($account+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'; if($LASTEXITCODE -ne 0){exit 1}`))
    const write = async (name: string, content: string) => { files.push(path.posix.join(stage,name)); await writeRemote(sftp!,path.posix.join(stage,name),content) }
    await write('manager-agent.cjs',await agentBundle())
    await write('manager-agent-supervisor.cjs',await readFile(path.join(process.cwd(),'scripts/manager-agent-supervisor.cjs'),'utf8'))
    await write('enrollment.json',JSON.stringify({ manager,serverId,enrollmentToken }))
    await write('tool-paths.json',JSON.stringify(reuse))
    if (ca) await write('manager-ca.crt',ca)
    const installer = server.platform === 'win32' ? 'bootstrap-remote-agent.ps1' : 'bootstrap-remote-agent.sh'
    await write(installer,(await readFile(path.join(process.cwd(),'scripts',installer),'utf8')).replace(/\r\n/g,'\n'))
    if (server.platform === 'win32') await write('downloads.json',JSON.stringify(downloads))
    else await write('downloads.env',Object.entries({NODE_URL:downloads.node?.url || '',NODE_SHA:downloads.node?.sha256 || '',CADDY_URL:downloads.caddy?.url || '',CADDY_SHA:downloads.caddy?.sha256 || '',PM2_VERSION:downloads.pm2Version || '',INSTALL_GIT:installs.includes('git') ? '1' : '0',...Object.fromEntries(Object.entries(reuse).map(([id,p]) => ['TOOL_'+id,p]))}).map(([key,value])=>`${key}=${shQuote(value)}`).join('\n'))
    await audit(userId,'server.ssh.setup.start',serverId,{host:target.host,port:target.port,username:target.username,fingerprint:body.fingerprint})
    const command = server.platform === 'win32' ? powershell(`& ${psQuote(windowsStage+'\\'+installer)}`) : `${privileged ? '' : sudo.prefix}/bin/bash ${shQuote(stage+'/'+installer)}`
    await sshExec(connection,command,server.platform === 'linux' && !privileged ? sudo.input : '',20*60*1000,safeLog)
    let online = false
    for (let attempt = 0; attempt < 15; attempt++) {
      const row = (await lease.query('select last_seen_at,metrics from managed_servers where id=$1',[serverId])).rows[0]
      if (row?.metrics && new Date(row.last_seen_at).getTime() >= started) { online = true; break }
      await new Promise(resolve => setTimeout(resolve,2000))
    }
    await audit(userId,'server.ssh.setup.finish',serverId,{host:target.host,online})
    return { online, log: redact(transcript,[...credentialSecrets(auth),enrollmentToken]), message: online ? 'Agent installed and reporting to Manager.' : 'Setup finished; no monitoring heartbeat yet. Check the startup service on the target.' }
  } catch (error) {
    await audit(userId,'server.ssh.setup.failed',serverId,{host:target.host})
    throw new ApiError(redact((error as Error).message,[...credentialSecrets(auth),enrollmentToken]), error instanceof ApiError ? error.status : 400)
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
