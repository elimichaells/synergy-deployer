import { NextResponse } from 'next/server'
import { ApiError, jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { listDataMigrationJobs } from '@/lib/data-migrations'
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
