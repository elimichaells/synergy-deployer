import { NextResponse } from 'next/server'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { listProjects } from '@/lib/projects'
import { requireRole } from '@/lib/rbac'

export async function GET() {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])
    return NextResponse.json({ projects: await listProjects() })
  } catch (error) { return jsonError(error) }
}
