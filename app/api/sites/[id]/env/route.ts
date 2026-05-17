import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { readFile, writeFile } from 'fs/promises'
import path from 'path'

const ALLOWED_ENV_FILES = ['.env', '.env.local']

export async function GET(request: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])

    const { rows } = await query<{ root_path: string }>(
      'select root_path from projects where id = $1',
      [context.params.id]
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
    const content = await readFile(filePath, 'utf8')

    return NextResponse.json({ file: fileName, content })
  } catch (error) {
    return jsonError(error)
  }
}

export async function POST(request: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])

    const body = await request.json().catch(() => null)
    if (!body?.content) {
      return NextResponse.json({ error: 'Missing content' }, { status: 400 })
    }

    const { rows } = await query<{ root_path: string }>(
      'select root_path from projects where id = $1',
      [context.params.id]
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
    await writeFile(filePath, body.content, 'utf8')

    return NextResponse.json({ ok: true })
  } catch (error) {
    return jsonError(error)
  }
}
