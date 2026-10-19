import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { readHealthHistory } from '@/lib/health-history'

export const dynamic = 'force-dynamic'
export async function GET(request: NextRequest) {
  try {
    requireRole(await getSessionFromCookie(), ['admin', 'operator', 'viewer'])
    const range = request.nextUrl.searchParams.get('range') || '24h'
    const service = request.nextUrl.searchParams.get('service') || undefined
    if (!['1h', '24h', '7d'].includes(range)) throw new ApiError('Choose a 1h, 24h or 7d history range', 400)
    if (service && (service.length > 200 || /[\x00-\x1f]/.test(service))) throw new ApiError('Invalid service name', 400)
    return NextResponse.json(await readHealthHistory(range, service), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return jsonError(error) }
}
