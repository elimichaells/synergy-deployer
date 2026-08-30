import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { deleteProjectDomain, syncProjectDomain } from '@/lib/cloudflare'
import { requireRole } from '@/lib/rbac'

export async function PATCH(_: Request, context: { params: Promise<{ id: string }> }) {
  try { const user=await getSessionFromCookie(); requireRole(user,['admin','operator']); const domain=await syncProjectDomain((await context.params).id); await audit(user?.id,'domain.sync',(await context.params).id); return NextResponse.json({domain}) }
  catch (error) { return jsonError(error) }
}
export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  try { const user=await getSessionFromCookie(); requireRole(user,['admin']); await deleteProjectDomain((await context.params).id); await audit(user?.id,'domain.delete',(await context.params).id); return NextResponse.json({ok:true}) }
  catch (error) { return jsonError(error) }
}
