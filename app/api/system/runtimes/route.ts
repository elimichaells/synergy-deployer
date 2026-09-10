import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { audit } from '@/lib/audit'
import { getInstalledRuntimeVersions, listRuntimeJobs, listRuntimes, startRuntimeJob, type RuntimeJobAction } from '@/lib/runtimes'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    if (new URL(request.url).searchParams.get('toolchains') === 'true') {
      return NextResponse.json({ runtimes: (['node', 'php', 'go'] as const).map(id => ({ id, name: id === 'node' ? 'Node.js' : id === 'php' ? 'PHP' : 'Go', installedVersions: getInstalledRuntimeVersions(id) })) })
    }
    const [runtimes, jobs] = await Promise.all([listRuntimes(), listRuntimeJobs()])
    return NextResponse.json({ runtimes, jobs })
  } catch (error) {
    return jsonError(error)
  }
}

export async function POST(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const body = await request.json().catch(() => ({}))
    const runtime = typeof body.runtime === 'string' ? body.runtime : ''
    const action = typeof body.action === 'string' ? body.action as RuntimeJobAction : 'install'
    const version = typeof body.version === 'string' ? body.version : null
    const job = await startRuntimeJob(runtime, action, version, user?.id)
    await audit(user?.id, `runtime.${action}`, runtime, { version, jobId: job.id })
    return NextResponse.json({ job }, { status: 202 })
  } catch (error) {
    return jsonError(error)
  }
}
