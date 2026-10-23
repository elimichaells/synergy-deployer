export interface RemoteMetrics {
  hostname: string
  platform: 'win32' | 'linux'
  version: string
  cpuPercent: number
  memoryTotal: number
  memoryFree: number
  diskTotal: number | null
  diskFree: number | null
  uptime: number
  addresses: string[]
  tools: { node: string; git: string | null; pm2: string | null; caddy: string | null }
  apps: { id: string; status: string; cpu: number; memory: number }[]
  proxyError?: string | null
}

export interface ManagedServer {
  id: string
  name: string
  location: string
  platform: 'win32' | 'linux'
  enabled: boolean
  enrolled_at: string | null
  last_seen_at: string | null
  metrics: RemoteMetrics | null
  status: 'pending' | 'online' | 'offline' | 'revoked'
  app_count: number
  has_ca: boolean
}

export interface RemoteApp {
  id: string
  server_id: string
  name: string
  repo_url: string
  branch: string
  install_cmd: string
  build_cmd: string
  start_cmd: string
  port: number
  health_path: string
  access_mode: 'lan' | 'wan'
  hostname: string
  ip_address: string
  ip_port: number | null
  git_connection_id: string | null
  env_names: string[]
  live_commit: string | null
  deployed_at: string | null
}

export interface RemoteJob {
  id: string
  app_id: string
  app_name: string
  status: 'queued' | 'running' | 'success' | 'failed' | 'cancelled'
  log: string
  commit_sha: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  updated_at: string
}
