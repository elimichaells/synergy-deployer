import { NextResponse } from 'next/server'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { requireSameOrigin,readBody } from '@/lib/request-body'
import { remoteOverridePlan,overrideRemoteDeployment } from '@/lib/remote-security-gate'
import { updateProtected } from '@/lib/update-maintenance'
type Context={params:Promise<{id:string;jobId:string}>}
export const dynamic='force-dynamic'
export async function GET(_request:Request,context:Context){try{
  requireRole(await getSessionFromCookie(),['admin','operator','viewer']);const {id,jobId}=await context.params
  return NextResponse.json({plan:await remoteOverridePlan(id,jobId)},{headers:{'Cache-Control':'no-store'}})
}catch(error){return jsonError(error)}}
export async function POST(request:Request,context:Context){try{
  const user=await getSessionFromCookie();requireRole(user,['admin']);requireSameOrigin(request);const body=await readBody(request,4000),{id,jobId}=await context.params
  return NextResponse.json(await updateProtected('Remote security override',()=>overrideRemoteDeployment(id,jobId,body,user!.id)))
}catch(error){return jsonError(error)}}
