import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { listDataMigrationJobs, RELATIONAL_MIGRATION_PROVIDERS, startDataMigration } from '@/lib/data-migrations'
import { requireRole } from '@/lib/rbac'

export async function GET(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    const projectId = new URL(request.url).searchParams.get('project') || undefined
    return NextResponse.json({ migrations: await listDataMigrationJobs(projectId), relationalProviders: RELATIONAL_MIGRATION_PROVIDERS })
  } catch (error) { return jsonError(error) }
}

export async function POST(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])
    const migration = await startDataMigration(await request.json(), user?.id)
    await audit(user?.id, 'data.migration.start', migration?.id || '', { source: migration?.source_service_id, target: migration?.target_service_id })
    return NextResponse.json({ migration }, { status: 202 })
  } catch (error) { return jsonError(error) }
}
