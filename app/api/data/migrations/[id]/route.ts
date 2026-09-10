import { NextResponse } from 'next/server'
import { ApiError, jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { deleteDataMigration, listDataMigrationJobs } from '@/lib/data-migrations'
import { audit } from '@/lib/audit'
import { requireRole } from '@/lib/rbac'

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    const id = (await context.params).id
    const migration = (await listDataMigrationJobs()).find((item) => item.id === id)
    if (!migration) throw new ApiError('Migration not found', 404)
    return NextResponse.json({ migration })
  } catch (error) { return jsonError(error) }
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const id = (await context.params).id
    const job = await deleteDataMigration(id)
    await audit(user?.id, 'data.migration.delete', job.project_id, { migrationId: id, sourceServiceId: job.source_service_id, targetServiceId: job.target_service_id, status: job.status })
    return NextResponse.json({ ok: true })
  } catch (error) { return jsonError(error) }
}
