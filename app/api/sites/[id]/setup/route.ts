import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { query } from '@/lib/db'
import { getProjectSetup, checkProjectSetup, completeProjectSetup, prepareSetupRepository } from '@/lib/project-setup'
import { validateSetupProgress } from '@/lib/project-setup-policy'
import { acquireProjectOperation } from '@/lib/project-operation'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }

export async function GET(_request: Request, context: Context) {
  try {
    requireRole(await getSessionFromCookie(), ['admin', 'operator', 'viewer'])
    return NextResponse.json(await getProjectSetup((await context.params).id), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return jsonError(error) }
}

export async function POST(request: Request, context: Context) {
  let release: (() => Promise<void>) | undefined
  try {
    requireRole(await getSessionFromCookie(), ['admin', 'operator'])
    const id = (await context.params).id
    const body = await request.json()
    await getProjectSetup(id)
    if (body.action === 'progress') {
      let progress
      try { progress = validateSetupProgress(body) } catch (error) { throw new ApiError((error as Error).message, 400) }
      await query(`insert into project_setup (project_id,step,decisions,completed_at)
        values ($1,$2,$3,case when exists(select 1 from deployments where project_id=$1 and status='success') then now() end)
        on conflict(project_id) do update set step=excluded.step,decisions=project_setup.decisions || excluded.decisions,updated_at=now()`, [id, progress.step, JSON.stringify(progress.decisions)])
      return NextResponse.json({ ok: true })
    }
    release = await acquireProjectOperation(id)
    if (body.action === 'validate' || body.action === 'complete') {
      const result = body.action === 'complete' ? await completeProjectSetup(id) : { checks: await checkProjectSetup(id) }
      return NextResponse.json(result)
    }
    if (body.action !== 'prepare') throw new ApiError('Unknown setup action', 400)
    const encoder = new TextEncoder()
    const abort = new AbortController()
    const unlock = release
    release = undefined
    const stream = new ReadableStream({
      start(controller) {
        const write = (text: string) => { try { controller.enqueue(encoder.encode(text)) } catch { /* Client disconnected. */ } }
        void prepareSetupRepository(id, write, abort.signal).catch(error => write(`[error] ${(error as Error).message}\n`)).finally(async () => {
          await unlock()
          try { controller.close() } catch { /* Client disconnected. */ }
        })
      },
      cancel() { abort.abort() },
    })
    return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } })
  } catch (error) { return jsonError(error) }
  finally { await release?.() }
}
