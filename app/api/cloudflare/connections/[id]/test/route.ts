import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { testCloudflareConnection } from '@/lib/cloudflare'
import { requireRole } from '@/lib/rbac'

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  try { const user=await getSessionFromCookie(); requireRole(user,['admin']); const result=await testCloudflareConnection((await context.params).id); await audit(user?.id,'cloudflare.connection.test',(await context.params).id,result); return NextResponse.json(result) }
  catch (error) { return jsonError(error) }
}
