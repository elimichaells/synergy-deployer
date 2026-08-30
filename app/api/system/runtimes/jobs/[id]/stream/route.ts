import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { getRuntimeJob } from '@/lib/runtimes'

export const dynamic = 'force-dynamic'

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    const id = (await context.params).id
    await getRuntimeJob(id)
    const encoder = new TextEncoder()
    let timer: NodeJS.Timeout | null = null
    const stream = new ReadableStream({
      async start(controller) {
        const send = async () => {
          try {
            const job = await getRuntimeJob(id)
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ job })}\n\n`))
            if (!['queued', 'running'].includes(job.status)) {
              if (timer) clearInterval(timer)
              controller.close()
            }
          } catch {
            if (timer) clearInterval(timer)
            controller.close()
          }
        }
        await send()
        const job = await getRuntimeJob(id)
        if (['queued', 'running'].includes(job.status)) timer = setInterval(send, 750)
      },
      cancel() { if (timer) clearInterval(timer) },
    })
    return new NextResponse(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' } })
  } catch (error) { return jsonError(error) }
}
