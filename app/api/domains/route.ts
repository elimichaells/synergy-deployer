import { NextResponse } from 'next/server'
import { audit } from '@/lib/audit'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { createProjectDomain, listProjectDomains } from '@/lib/cloudflare'
import { requireRole } from '@/lib/rbac'

export async function GET(request: Request) {
  try { const user=await getSessionFromCookie(); requireRole(user,['admin','operator','viewer']); const projectId=new URL(request.url).searchParams.get('project') || undefined; return NextResponse.json({domains:await listProjectDomains(projectId)}) }
  catch (error) { return jsonError(error) }
}
export async function POST(request: Request) {
  try { const user=await getSessionFromCookie(); requireRole(user,['admin']); const body=await request.json(); const domain=await createProjectDomain(String(body.projectId || ''),body,user?.id); await audit(user?.id,'domain.create',domain?.id || '',{hostname:domain?.hostname,projectId:body.projectId}); return NextResponse.json({domain},{status:201}) }
  catch (error) { return jsonError(error) }
}
