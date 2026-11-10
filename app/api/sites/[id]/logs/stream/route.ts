import { tailRuntimeLog,runtimeLogSecrets,redactRuntimeLog } from '@/lib/runtime-log-reader'
import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

const tailLines=tailRuntimeLog

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])

    const { rows: projectRows } = await query<{ pm2_name: string;root_path:string }>(
      'select pm2_name,root_path from projects where id = $1',
      [(await context.params).id]
    )

    const project = projectRows[0]
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const url = new URL(request.url)
    const type = url.searchParams.get('type') === 'err' ? 'err' : 'out'
    const lines = Math.max(1,Math.min(parseInt(url.searchParams.get('lines') || '200', 10)||200, 2000))

    const { stdout } = await execAsync('pm2 jlist', {
      windowsHide: true,
      encoding: 'utf8',
    })

    const list = JSON.parse(stdout) as Array<{
      name: string
      pm2_env?: { pm_out_log_path?: string; pm_err_log_path?: string;env?:Record<string,unknown> }
    }>

    const match = list.find((item) => item.name === project.pm2_name)
    const logPath = type === 'err' ? match?.pm2_env?.pm_err_log_path : match?.pm2_env?.pm_out_log_path

    if (!logPath) {
      return NextResponse.json({ error: 'Log path not found for PM2 process' }, { status: 404 })
    }

    const encoder = new TextEncoder()
    let interval: NodeJS.Timeout | null = null
    let cancelled=false,reading=false
    const stop=()=>{cancelled=true;if(interval)clearInterval(interval);request.signal.removeEventListener('abort',stop)}
    request.signal.addEventListener('abort',stop,{once:true})

    const stream = new ReadableStream({
      async start(controller) {
        const send = async () => {
          if(cancelled||reading)return
          reading=true
          try {
            const log = redactRuntimeLog(await tailLines(logPath, lines),await runtimeLogSecrets(project.root_path,match?.pm2_env?.env))
            const payload = `data: ${JSON.stringify({ log, logPath })}\n\n`
            if(!cancelled)controller.enqueue(encoder.encode(payload))
          } catch (error) {
            const payload = `event: error\ndata: ${JSON.stringify({ error: 'Failed to read logs' })}\n\n`
            if(!cancelled)controller.enqueue(encoder.encode(payload))
          }finally{reading=false}
        }

        await send()
        if(!cancelled)interval = setInterval(send, 2000)
      },
      cancel() {
        stop()
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
