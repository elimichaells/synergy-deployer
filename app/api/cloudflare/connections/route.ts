import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { createCloudflareConnection, listCloudflareConnections } from '@/lib/cloudflare'
import { requireRole } from '@/lib/rbac'

export async function GET() {
  try { const user=await getSessionFromCookie(); requireRole(user,['admin','operator','viewer']); return NextResponse.json({ connections: await listCloudflareConnections() }) }
  catch (error) { return jsonError(error) }
}
export async function POST(request: Request) {
  try { const user=await getSessionFromCookie(); requireRole(user,['admin']); const body=await request.json(); const connection=await createCloudflareConnection(body.name,body.token,user?.id); await audit(user?.id,'cloudflare.connection.create',connection?.id || '',{name:connection?.name}); return NextResponse.json({connection},{status:201}) }
  catch (error) { return jsonError(error) }
}
