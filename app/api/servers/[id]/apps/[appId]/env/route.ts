import { NextResponse } from 'next/server'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { requireSameOrigin,readBody } from '@/lib/request-body'
import { readRemoteEnvironmentFile,saveRemoteEnvironmentFile } from '@/lib/remote-environment'
import { updateProtected } from '@/lib/update-maintenance'
type Context={params:Promise<{id:string;appId:string}>}
export const dynamic='force-dynamic'
export async function GET(request:Request,context:Context){try{
  requireRole(await getSessionFromCookie(),['admin','operator']);const {id,appId}=await context.params
  return NextResponse.json(await readRemoteEnvironmentFile(id,appId,new URL(request.url).searchParams.get('file')||'.env'),{headers:{'Cache-Control':'no-store'}})
}catch(error){return jsonError(error)}}
export async function POST(request:Request,context:Context){try{
  const user=await getSessionFromCookie();requireRole(user,['admin','operator']);requireSameOrigin(request);const body=await readBody(request,800000),{id,appId}=await context.params
  return NextResponse.json(await updateProtected('Remote environment settings',()=>saveRemoteEnvironmentFile(id,appId,body,user!.id)))
}catch(error){return jsonError(error)}}
