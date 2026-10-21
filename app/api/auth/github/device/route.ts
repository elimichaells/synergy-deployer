import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { getSetting } from '@/lib/settings'

/**
 * GitHub Device Flow — Step 1: Request device + user codes
 * POST /api/auth/github/device
 */
export async function POST() {
    try {
        const user = await getSessionFromCookie()
        requireRole(user, ['admin'])

        const clientId = await getSetting('GITHUB_CLIENT_ID')
        if (!clientId) {
            return NextResponse.json(
                { error: 'Save your GitHub OAuth client ID in Settings → Connections → GitHub application.' },
                { status: 409 }
            )
        }

        const res = await fetch('https://github.com/login/device/code', {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                client_id: clientId,
                scope: 'repo',
            }),
        })

        if (!res.ok) {
            const text = await res.text()
            return NextResponse.json(
                { error: `GitHub returned ${res.status}: ${text}` },
                { status: 502 }
            )
        }

        const data = await res.json()

        // data contains: device_code, user_code, verification_uri, expires_in, interval
        return NextResponse.json({
            deviceCode: data.device_code,
            userCode: data.user_code,
            verificationUri: data.verification_uri,
            expiresIn: data.expires_in,
            interval: data.interval,
        })
    } catch (error) {
        return jsonError(error)
    }
}
