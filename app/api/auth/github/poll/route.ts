import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { query } from '@/lib/db'

/**
 * GitHub Device Flow — Step 2: Poll for access token
 * POST /api/auth/github/poll
 * Body: { deviceCode: string }
 */
export async function POST(request: NextRequest) {
    try {
        const user = getSessionFromCookie()
        requireRole(user, ['admin'])

        const clientId = process.env.GITHUB_CLIENT_ID
        if (!clientId) {
            return NextResponse.json(
                { error: 'GITHUB_CLIENT_ID is not configured' },
                { status: 500 }
            )
        }

        const body = await request.json()
        const { deviceCode } = body

        if (!deviceCode) {
            return NextResponse.json({ error: 'deviceCode is required' }, { status: 400 })
        }

        const res = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                client_id: clientId,
                device_code: deviceCode,
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            }),
        })

        if (!res.ok) {
            return NextResponse.json(
                { error: `GitHub returned ${res.status}` },
                { status: 502 }
            )
        }

        const data = await res.json()

        // Possible states:
        // - { error: 'authorization_pending' } — user hasn't entered code yet
        // - { error: 'slow_down' } — polling too fast
        // - { error: 'expired_token' } — device code expired
        // - { access_token, token_type, scope } — success!

        if (data.error) {
            return NextResponse.json({
                status: data.error,
                message: data.error_description || data.error,
            })
        }

        if (data.access_token) {
            // Save the token to the database
            await query(
                `INSERT INTO settings (key, value)
         VALUES ('GITHUB_TOKEN', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
                [data.access_token]
            )

            // Verify the token by fetching user info
            const userRes = await fetch('https://api.github.com/user', {
                headers: {
                    Authorization: `Bearer ${data.access_token}`,
                    'User-Agent': 'DeployManager',
                },
            })

            let githubUser = null
            if (userRes.ok) {
                const userData = await userRes.json()
                githubUser = {
                    login: userData.login,
                    name: userData.name,
                    avatar: userData.avatar_url,
                }
            }

            return NextResponse.json({
                status: 'success',
                scope: data.scope,
                githubUser,
            })
        }

        return NextResponse.json({ status: 'unknown', data })
    } catch (error) {
        return jsonError(error)
    }
}
