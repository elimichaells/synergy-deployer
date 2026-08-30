import { NextResponse } from 'next/server'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { listCloudflareZones } from '@/lib/cloudflare'
import { requireRole } from '@/lib/rbac'

export async function GET(request: Request) {
  try { const user=await getSessionFromCookie(); requireRole(user,['admin','operator','viewer']); const id=new URL(request.url).searchParams.get('connection') || undefined; return NextResponse.json({zones:await listCloudflareZones(id)}) }
  catch (error) { return jsonError(error) }
}
