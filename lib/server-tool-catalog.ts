export const SERVER_TOOLS = [
  { id: 'node', name: 'Node.js', required: true },
  { id: 'git', name: 'Git', required: true },
  { id: 'caddy', name: 'Caddy', required: true },
  { id: 'pm2', name: 'PM2', required: true },
  { id: 'psql', name: 'PostgreSQL client', required: false },
  { id: 'pg_dump', name: 'PostgreSQL backup client', required: false },
  { id: 'pg_restore', name: 'PostgreSQL restore client', required: false },
  { id: 'mysql', name: 'MySQL client', required: false },
  { id: 'mariadb', name: 'MariaDB client', required: false },
  { id: 'go', name: 'Go', required: false },
  { id: 'php', name: 'PHP', required: false },
  { id: 'python', name: 'Python', required: false },
  { id: 'composer', name: 'Composer', required: false },
  { id: 'ng', name: 'Angular CLI', required: false },
  { id: 'sling', name: 'Sling migration engine', required: false },
] as const
export type ServerToolId = typeof SERVER_TOOLS[number]['id']
export type ToolSelection = { mode: 'reuse' | 'install' | 'skip'; path: string }
export type ServerToolPlan = Record<ServerToolId, ToolSelection>
export type ToolCandidate = { path: string; version: string; compatible: boolean; error?: string }
export interface ServerInventory {
  platform: 'win32' | 'linux'; arch: string; privileged: boolean; portsKnown: boolean
  ports: number[]; services: { name: string; status: string; executable: string; config: string }[]
  tools: Record<ServerToolId, ToolCandidate[]>
}
