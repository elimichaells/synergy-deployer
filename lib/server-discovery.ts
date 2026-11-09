import path from 'node:path'
import { SERVER_TOOLS, type ServerToolId, type ToolSelection, type ServerToolPlan, type ServerInventory } from './server-tool-catalog'

export function toolPath(value: unknown, platform: string, id: string): string {
  if (!SERVER_TOOLS.some(tool => tool.id === id)) throw new Error('Unknown server tool')
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Enter an absolute executable path for ${id}`)
  const p = value.trim()
  if (platform === 'win32') {
    // Local Service cannot use an interactive user's mapped drives or network credentials.
    if (!/^[a-z]:[\\/]/i.test(p) || /[;"<>|*?]/.test(p) || p.slice(2).includes(':') || (id !== 'pm2' && !(id === 'composer' ? /\.(?:exe|bat|cmd)$/i : /\.exe$/i).test(p))) throw new Error(`Use a local absolute ${id === 'pm2' ? 'PM2 bin/pm2 script' : '.exe'} path for ${id}`)
    return path.win32.normalize(p)
  }
  if (platform !== 'linux' || !p.startsWith('/') || /[:\r\n]/.test(p)) throw new Error(`Use an absolute Linux executable path for ${id}`)
  return path.posix.normalize(p)
}

export function toolCompatible(id: ServerToolId, version: string) {
  const major = Number(version.match(/(?:^|\D)(\d+)\./)?.[1])
  if (id === 'node') return /^v\d+\.\d+\.\d+/.test(version) && major >= 22
  if (id === 'caddy') return /^v?2\./.test(version)
  if (id === 'git') return /^git version 2\./.test(version)
  if (id === 'pm2') return /^\d+\.\d+\.\d+/.test(version) && major >= 5
  const signatures: Record<string, RegExp> = { psql: /^psql .*PostgreSQL/i, pg_dump: /^pg_dump .*PostgreSQL/i, pg_restore: /^pg_restore .*PostgreSQL/i, mysql: /mysql.*(?:Ver|Distrib)/i, mariadb: /mariadb.*(?:Ver|Distrib)|mysql.*MariaDB/i, go: /^go version go\d/i, php: /^PHP \d/i, python: /^Python 3\./i, composer: /^Composer version /i, sling: /^(?:sling )?version:? v?1\./i, ng: /^Angular CLI\s*:\s*\d+\./i }
  return !!signatures[id]?.test(version)
}

export function discoveryPaths(value: unknown, platform: string): Partial<Record<ServerToolId, string>> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid tool paths')
  return Object.fromEntries(Object.entries(value).map(([id, p]) => [id, toolPath(p, platform, id)]))
}

export function selectedTools(value: unknown, platform: string): ServerToolPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Inspect this server and review its tools before installing')
  const supplied = value as Record<string, ToolSelection>
  if (Object.keys(supplied).some(id => !SERVER_TOOLS.some(tool => tool.id === id))) throw new Error('Unknown server tool')
  return Object.fromEntries(SERVER_TOOLS.map(tool => {
    const item = supplied[tool.id]
    if (!item || !['reuse', ...(tool.required ? ['install'] : ['skip'])].includes(item.mode)) throw new Error(`Choose how to configure ${tool.name}`)
    return [tool.id, { mode: item.mode, path: item.mode === 'reuse' ? toolPath(item.path, platform, tool.id) : '' }]
  })) as ServerToolPlan
}

export function verifyToolPlan(plan: ServerToolPlan, inventory: ServerInventory) {
  if (!inventory.portsKnown) throw new Error('Could not inspect listening ports. Install the OS networking tools and inspect again.')
  const conflicts = inventory.ports.filter(port => [80,443,2029].includes(port))
  if (conflicts.length) throw new Error(`Ports ${conflicts.join(', ')} are already in use. Existing web services are preserved. Integrate or migrate their routes before connecting this agent; choosing a Caddy executable does not adopt its running configuration.`)
  for (const tool of SERVER_TOOLS) {
    const item = plan[tool.id]
    if (item.mode !== 'reuse') continue
    const same = (p: string) => inventory.platform === 'win32' ? p.toLowerCase() === item.path.toLowerCase() : p === item.path
    if (!inventory.tools[tool.id].some(candidate => same(candidate.path) && candidate.compatible)) throw new Error(`${tool.name} is missing, incompatible or inaccessible at the selected path. Inspect the server again.`)
  }
}
