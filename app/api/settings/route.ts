import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { getSettings, updateSettings, type SettingKey } from '@/lib/settings'
import { query } from '@/lib/db'

const VALID_KEYS: SettingKey[] = [
  'PRODUCTION_PATH',
  'STAGING_PATH',
  'LOGS_PATH',
  'CADDY_PATH',
  'GITHUB_TOKEN',
  'NOTIFY_WEBHOOK_URL',
  'BACKUP_DIR',
  'BACKUP_ENABLED',
  'BACKUP_RETENTION_DAYS',
  'PG_BIN_PATH',
]

export async function GET() {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])

    const settings = await getSettings()

    // Mask GITHUB_TOKEN for non-admin users
    if (user!.role !== 'admin') {
      const token = settings.GITHUB_TOKEN
      settings.GITHUB_TOKEN = token
        ? '*'.repeat(Math.max(0, token.length - 4)) + token.slice(-4)
        : ''
    }

    return NextResponse.json(settings)
  } catch (error) {
    return jsonError(error)
  }
}

export async function PUT(request: Request) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin'])

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
    }

    const updates: Partial<Record<SettingKey, string>> = {}
    for (const key of VALID_KEYS) {
      if (key in body && typeof body[key] === 'string') {
        updates[key] = body[key]
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid settings provided' }, { status: 400 })
    }

    await updateSettings(updates)

    await query(
      `INSERT INTO audit_logs (user_id, action, resource, details)
       VALUES ($1, 'update', 'settings', $2)`,
      [user!.id, JSON.stringify({ updated: Object.keys(updates) })]
    )

    return NextResponse.json({ ok: true, updated: Object.keys(updates) })
  } catch (error) {
    return jsonError(error)
  }
}
