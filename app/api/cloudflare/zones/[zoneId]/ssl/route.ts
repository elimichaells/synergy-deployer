import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { setZoneSslMode } from '@/lib/cloudflare'
import { requireRole } from '@/lib/rbac'

export async function PATCH(request: Request, context: { params: Promise<{ zoneId: string }> }) {
  try { const user=await getSessionFromCookie(); requireRole(user,['admin']); const body=await request.json(); const setting=await setZoneSslMode(String(body.connectionId || ''),(await context.params).zoneId,String(body.mode || '')); await audit(user?.id,'cloudflare.ssl.update',(await context.params).zoneId,{mode:body.mode}); return NextResponse.json({setting}) }
  catch (error) { return jsonError(error) }
}
