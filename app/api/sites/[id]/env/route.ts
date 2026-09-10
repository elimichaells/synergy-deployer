import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'

const ALLOWED_ENV_FILES = ['.env', '.env.local']

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])

    const { rows } = await query<{ root_path: string }>(
      'select root_path from projects where id = $1',
      [(await context.params).id]
    )

    const project = rows[0]
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const url = new URL(request.url)
    const fileName = url.searchParams.get('file') || '.env'
    if (!ALLOWED_ENV_FILES.includes(fileName)) {
      return NextResponse.json({ error: 'Unsupported env file' }, { status: 400 })
    }

    const filePath = path.join(project.root_path, fileName)
    const content = await readFile(filePath, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    })

    return NextResponse.json({ file: fileName, content }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return jsonError(error)
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])

    const body = await request.json().catch(() => null)
    if (typeof body?.content !== 'string' || body.content.length > 500_000) {
      return NextResponse.json({ error: 'Environment content must be text, at most 500,000 characters' }, { status: 400 })
    }

    const { rows } = await query<{ root_path: string }>(
      'select root_path from projects where id = $1',
      [(await context.params).id]
    )

    const project = rows[0]
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const fileName = body.file || '.env'
    if (!ALLOWED_ENV_FILES.includes(fileName)) {
      return NextResponse.json({ error: 'Unsupported env file' }, { status: 400 })
    }

    const filePath = path.join(project.root_path, fileName)
    if (!existsSync(path.join(project.root_path, '.git'))) {
      const { ensureProjectSetupSchema } = await import('@/lib/project-setup')
      await ensureProjectSetupSchema()
      const setup = await query('select project_id from project_setup where project_id=$1 and completed_at is null', [(await context.params).id])
      if (setup.rows.length) return NextResponse.json({ error: 'Prepare the repository in Setup before saving environment files' }, { status: 409 })
    }
    await writeFile(filePath, body.content, 'utf8')

    return NextResponse.json({ ok: true })
  } catch (error) {
    return jsonError(error)
  }
}
