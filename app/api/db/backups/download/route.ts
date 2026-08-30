import { NextResponse } from 'next/server'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { Readable } from 'stream'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { resolveBackupFile } from '@/lib/backups'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin'])

    const url = new URL(request.url)
    const file = url.searchParams.get('file') || ''
    const filePath = await resolveBackupFile(file)
    const info = await stat(filePath)

    const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream

    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(info.size),
        'Content-Disposition': `attachment; filename="${file}"`,
        'Cache-Control': 'no-cache',
      },
    })
  } catch (error) {
    return jsonError(error)
  }
}
