import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { exec } from 'child_process'
import { promisify } from 'util'
import { readFile, writeFile } from 'fs/promises'

const execAsync = promisify(exec)

async function tailLines(filePath: string, lines: number) {
  const content = await readFile(filePath, 'utf8')
  const parts = content.split(/\r?\n/)
  if (parts.length <= lines) return parts.join('\n')
  return parts.slice(-lines).join('\n')
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])

    const { rows: projectRows } = await query<{ pm2_name: string }>(
      'select pm2_name from projects where id = $1',
      [(await context.params).id]
    )

    const project = projectRows[0]
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const url = new URL(request.url)
    const type = url.searchParams.get('type') === 'err' ? 'err' : 'out'
    const lines = Math.min(parseInt(url.searchParams.get('lines') || '200', 10), 2000)

    const { stdout } = await execAsync('pm2 jlist', {
      windowsHide: true,
      encoding: 'utf8',
    })

    const list = JSON.parse(stdout) as Array<{
      name: string
      pm2_env?: { pm_out_log_path?: string; pm_err_log_path?: string }
    }>

    const match = list.find((item) => item.name === project.pm2_name)
    const logPath = type === 'err' ? match?.pm2_env?.pm_err_log_path : match?.pm2_env?.pm_out_log_path

    if (!logPath) {
      return NextResponse.json({ error: 'Log path not found for PM2 process' }, { status: 404 })
    }

    const log = await tailLines(logPath, lines)

    return NextResponse.json({ logPath, type, lines, log })
  } catch (error) {
    return jsonError(error)
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])

    const { rows: projectRows } = await query<{ pm2_name: string }>(
      'select pm2_name from projects where id = $1',
      [(await context.params).id]
    )

    const project = projectRows[0]
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const url = new URL(request.url)
    const type = url.searchParams.get('type') === 'err' ? 'err' : 'out'

    const { stdout } = await execAsync('pm2 jlist', {
      windowsHide: true,
      encoding: 'utf8',
    })

    const list = JSON.parse(stdout) as Array<{
      name: string
      pm2_env?: { pm_out_log_path?: string; pm_err_log_path?: string }
    }>

    const match = list.find((item) => item.name === project.pm2_name)
    const logPath = type === 'err' ? match?.pm2_env?.pm_err_log_path : match?.pm2_env?.pm_out_log_path

    if (!logPath) {
      return NextResponse.json({ error: 'Log path not found' }, { status: 404 })
    }

    await writeFile(logPath, '', 'utf8')

    return NextResponse.json({ cleared: true, logPath, type })
  } catch (error) {
    return jsonError(error)
  }
}
