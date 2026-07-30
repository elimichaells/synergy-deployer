import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { listBackups, createBackup, deleteBackup } from '@/lib/backups'
import { audit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin'])
    return NextResponse.json({ backups: await listBackups() })
  } catch (error) {
    return jsonError(error)
  }
}

/** Create a backup of one database now */
export async function POST(request: Request) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin'])

    const body = await request.json().catch(() => null)
    const database: string = (body?.database || '').trim()
    if (!database) {
      return NextResponse.json({ error: 'Database name is required' }, { status: 400 })
    }

    const backup = await createBackup(database)
    await audit(user?.id, 'database.backup', database, { file: backup.file, size: backup.size_bytes })

    return NextResponse.json(backup)
  } catch (error) {
    return jsonError(error)
  }
}

export async function DELETE(request: Request) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin'])

    const body = await request.json().catch(() => null)
    const file: string = body?.file || ''
    if (!file) {
      return NextResponse.json({ error: 'File name is required' }, { status: 400 })
    }

    await deleteBackup(file)
    await audit(user?.id, 'database.backup.delete', file)

    return NextResponse.json({ ok: true })
  } catch (error) {
    return jsonError(error)
  }
}
