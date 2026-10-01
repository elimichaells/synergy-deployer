import { readFile } from 'fs/promises'
import path from 'path'
import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { query } from '@/lib/db'
import { envNames, type EnvFileSummary } from '@/lib/env-names'

export const dynamic = 'force-dynamic'
const FILES = ['.env', '.env.local']

/** For every app in a project: which env files exist and the variable names in them. Values are never returned. */
export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    const id = (await context.params).id
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new ApiError('Project not found', 404)
    const { rows } = await query<{ id: string; root_path: string }>('select id, root_path from projects where application_group_id = $1', [id])
    const apps: Record<string, EnvFileSummary[]> = {}
    for (const app of rows) {
      apps[app.id] = await Promise.all(FILES.map(async (file): Promise<EnvFileSummary> => {
        try { return { file, exists: true, names: envNames(await readFile(path.join(app.root_path, file), 'utf8')) } }
        catch { return { file, exists: false, names: [] } }
      }))
    }
    return NextResponse.json({ apps }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return jsonError(error) }
}
