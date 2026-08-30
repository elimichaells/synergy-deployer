import { NextRequest, NextResponse } from 'next/server'
import { exec } from 'child_process'
import { promisify } from 'util'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { startDeploy, type DeployProject } from '@/lib/deploy'

const execAsync = promisify(exec)

interface RouteParams {
  params: Promise<{
    id: string
    action: string
  }>
}

export async function POST(
  request: NextRequest,
  { params }: RouteParams
) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])

    const { id, action } = await params

    const { rows } = await query<DeployProject & {
      id: string
      name: string
    }>(
      'select id, name, repo_url, default_branch, project_type, root_path, install_cmd, build_cmd, deploy_script, start_cmd, pre_deploy_cmd, post_deploy_cmd, runtime_versions, pm2_name, port, github_connection_id from projects where id = $1',
      [id]
    )

    const app = rows[0]
    if (!app) {
      return NextResponse.json({ error: 'Service not found' }, { status: 404 })
    }

    switch (action) {
      case 'start':
        await execAsync(`pm2 restart ${app.pm2_name}`, { windowsHide: true })
        await execAsync('pm2 save', { windowsHide: true })
        await query('update projects set is_active = true where id = $1', [id])
        return NextResponse.json({ success: true, message: `${app.name} started` })

      case 'stop':
        await execAsync(`pm2 stop ${app.pm2_name}`, { windowsHide: true })
        await execAsync('pm2 save', { windowsHide: true })
        await query('update projects set is_active = false where id = $1', [id])
        return NextResponse.json({ success: true, message: `${app.name} stopped` })

      case 'restart':
        await execAsync(`pm2 restart ${app.pm2_name}`, { windowsHide: true })
        await execAsync('pm2 save', { windowsHide: true })
        await query('update projects set is_active = true where id = $1', [id])
        return NextResponse.json({ success: true, message: `${app.name} restarted` })

      case 'deploy':
        if (!app.repo_url) {
          return NextResponse.json({ error: 'Git not configured for this service' }, { status: 400 })
        }

        const deploymentId = await startDeploy(app, { userId: user?.id, trigger: 'manual' })
        if (!deploymentId) {
          return NextResponse.json({ error: 'Deploy already running for this service' }, { status: 409 })
        }

        return NextResponse.json({ success: true, deploymentId, message: `${app.name} deployment started` })

      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }
  } catch (error) {
    return jsonError(error)
  }
}
