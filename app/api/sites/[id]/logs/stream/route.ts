import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { exec } from 'child_process'
import { promisify } from 'util'
import { readFile } from 'fs/promises'

const execAsync = promisify(exec)

async function tailLines(filePath: string, lines: number) {
  const content = await readFile(filePath, 'utf8')
  const parts = content.split(/\r?\n/)
  if (parts.length <= lines) return parts.join('\n')
  return parts.slice(-lines).join('\n')
}

export async function GET(request: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])

    const { rows: projectRows } = await query<{ pm2_name: string }>(
      'select pm2_name from projects where id = $1',
      [context.params.id]
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

    const encoder = new TextEncoder()
    let interval: NodeJS.Timeout | null = null

    const stream = new ReadableStream({
      async start(controller) {
        const send = async () => {
          try {
            const log = await tailLines(logPath, lines)
            const payload = `data: ${JSON.stringify({ log, logPath })}\n\n`
            controller.enqueue(encoder.encode(payload))
          } catch (error) {
            const payload = `event: error\ndata: ${JSON.stringify({ error: 'Failed to read logs' })}\n\n`
            controller.enqueue(encoder.encode(payload))
          }
        }

        await send()
        interval = setInterval(send, 2000)
      },
      cancel() {
        if (interval) clearInterval(interval)
      },
    })

    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    })
  } catch (error) {
    return jsonError(error)
  }
}
