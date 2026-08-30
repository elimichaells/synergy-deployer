import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { deleteCloudflareConnection } from '@/lib/cloudflare'
import { requireRole } from '@/lib/rbac'

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  try { const user=await getSessionFromCookie(); requireRole(user,['admin']); await deleteCloudflareConnection((await context.params).id); await audit(user?.id,'cloudflare.connection.delete',(await context.params).id); return NextResponse.json({ok:true}) }
  catch (error) { return jsonError(error) }
}
