import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { sendNotification } from '@/lib/notify'

export const dynamic = 'force-dynamic'

export async function POST() {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin'])

    const ok = await sendNotification(
      'Test notification',
      `Webhook is working — sent from the manager by ${user?.name || 'an admin'}.`,
      'info',
      [{ name: 'Source', value: 'Settings → Test' }]
    )

    if (!ok) {
      return NextResponse.json(
        { error: 'Failed to send. Check that NOTIFY_WEBHOOK_URL is saved and reachable.' },
        { status: 400 }
      )
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    return jsonError(error)
  }
}
