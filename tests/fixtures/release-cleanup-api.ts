import { NextResponse } from 'next/server'

const root = 'C:\\web\\production\\.manager-releases\\example-app'
const entries = [
  { path: root + '\\current-release', name: 'current-release', kind: 'release', bytes: 1.8 * 1024 ** 3, eligible: false, reason: 'Current deployment and its rollback copy' },
  { path: root + '\\older-release', name: 'older-release', kind: 'release', bytes: 1.4 * 1024 ** 3, eligible: false, reason: 'One of the latest three successful deployments' },
  { path: root + '\\expired-build', name: 'expired-build', kind: 'release', bytes: 2.2 * 1024 ** 3, eligible: true, reason: 'Expired failed build workspace' },
]
type Run = { id: string; mode: string; source: string; status: string; started_at: string; finished_at: string | null; report: Record<string, unknown> }
const state = (globalThis as unknown as { __cleanupFixture?: { enabled: boolean; history: Run[]; cleaned: boolean } }).__cleanupFixture ??= { enabled: false, history: [], cleaned: false }
export async function releaseCleanupFixture(request: Request, role: string) {
  if (new URL(request.url).pathname !== '/api/system/release-cleanup') return null
  if (request.method === 'GET') return NextResponse.json({ role, enabled: state.enabled, history: state.history,
    volumes: [{ path: 'C:\\web', locations: ['C:\\web\\manager', 'C:\\web\\production', 'C:\\web\\staging'], free: (state.cleaned ? 46.2 : 44) * 1024 ** 3, total: 304 * 1024 ** 3 }] })
  if (role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const body = await request.json()
  if (body.action === 'settings') { state.enabled = body.enabled === true; return NextResponse.json({ ok: true }) }
  const run: Run = { id: String(Date.now()), mode: body.action, source: 'manual', status: 'running', started_at: new Date().toISOString(), finished_at: null, report: { progress: 'Inspecting Customer portal' } }
  state.history.unshift(run)
  setTimeout(() => {
    const shown = state.cleaned ? entries.filter(e => !e.eligible) : entries
    const removed = body.action === 'clean' ? shown.filter(e => e.eligible).map(e => ({ path: e.path, bytes: e.bytes })) : []
    run.report = { progress: 'Complete', projects: [{ projectName: 'Customer portal', projectId: 'example-app', root, entries: shown, warnings: [] }], removed,
      warnings: [], eligibleBytes: shown.filter(e => e.eligible).reduce((n, e) => n + e.bytes, 0), retainedBytes: 3.2 * 1024 ** 3, removedBytes: removed.reduce((n, e) => n + e.bytes, 0) }
    run.status = 'completed'; run.finished_at = new Date().toISOString()
    if (body.action === 'clean') state.cleaned = true
  }, 1200)
  return NextResponse.json({ id: run.id }, { status: 202 })
}
