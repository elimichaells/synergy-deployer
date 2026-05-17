import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'

export async function GET(_request: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])

    const deploymentId = context.params.id

    // Verify deployment exists
    const { rows } = await query<{ id: string; status: string }>(
      'SELECT id, status FROM deployments WHERE id = $1',
      [deploymentId]
    )
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Deployment not found' }, { status: 404 })
    }

    const encoder = new TextEncoder()
    let interval: NodeJS.Timeout | null = null

    const stream = new ReadableStream({
      async start(controller) {
        const send = async () => {
          try {
            const { rows: current } = await query<{ log: string | null; status: string }>(
              'SELECT log, status FROM deployments WHERE id = $1',
              [deploymentId]
            )
            if (current.length === 0) {
              controller.close()
              if (interval) clearInterval(interval)
              return
            }

            const { log, status } = current[0]
            const payload = `data: ${JSON.stringify({ log: log || '', status })}\n\n`
            controller.enqueue(encoder.encode(payload))

            // Auto-close when deployment is no longer running
            if (status !== 'running') {
              if (interval) clearInterval(interval)
              controller.close()
            }
          } catch {
            if (interval) clearInterval(interval)
            controller.close()
          }
        }

        await send()
        // Only keep polling if not already closed
        const { rows: check } = await query<{ status: string }>(
          'SELECT status FROM deployments WHERE id = $1',
          [deploymentId]
        )
        if (check.length > 0 && check[0].status === 'running') {
          interval = setInterval(send, 1500)
        }
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
