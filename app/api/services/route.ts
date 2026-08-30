import { NextResponse } from 'next/server'
import { exec } from 'child_process'
import { promisify } from 'util'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'

const execAsync = promisify(exec)

interface PM2Process {
  name: string
  pid: number
  pm2_env: {
    status: string
    pm_uptime?: number
    restart_time: number
  }
  monit?: {
    cpu: number
    memory: number
  }
}

export async function GET() {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])

    const { stdout } = await execAsync('pm2 jlist', {
      windowsHide: true,
      encoding: 'utf8'
    })

    const pm2List: PM2Process[] = JSON.parse(stdout)

    const { rows: projects } = await query<{
      id: string
      name: string
      pm2_name: string
      port: number | null
      url: string | null
    }>(
      `select id, name, pm2_name, port, url
       from projects
       order by created_at asc`
    )

    const services = projects.map((app: { pm2_name: string; id: any; name: any; url: any; port: any }) => {
      const pm2Process = pm2List.find(p => p.name === app.pm2_name)

      if (!pm2Process) {
        return {
          id: app.id,
          name: app.pm2_name,
          displayName: app.name,
          status: 'stopped' as const,
          uptime: null,
          cpu: 0,
          memory: 0,
          restarts: 0,
          color: '#64748b',
          icon: '🧩',
          url: app.url,
          port: app.port,
          hasGit: true
        }
      }

      const status = pm2Process.pm2_env.status === 'online' ? 'online' :
        pm2Process.pm2_env.status === 'errored' ? 'errored' : 'stopped'

      const cpu = Math.round(pm2Process.monit?.cpu || 0)
      const memory = Math.round((pm2Process.monit?.memory || 0) / 1024 / 1024)

      return {
        id: app.id,
        name: app.pm2_name,
        displayName: app.name,
        status,
        uptime: pm2Process.pm2_env.pm_uptime || null,
        cpu,
        memory,
        restarts: pm2Process.pm2_env.restart_time || 0,
        color: '#2563eb',
        icon: '⚡',
        url: app.url,
        port: app.port,
        hasGit: true
      }
    })

    return NextResponse.json(services)
  } catch (error) {
    return jsonError(error)
  }
}
