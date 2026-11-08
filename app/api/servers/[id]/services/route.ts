import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError,jsonError } from '@/lib/api'
import { readBody,requireSameOrigin } from '@/lib/request-body'
import { reviewRemoteService,installRemoteService,remoteServiceHistory,remoteServiceCredentials,recoverRemoteService } from '@/lib/remote-services'
import { updateProtected } from '@/lib/update-maintenance'
export const dynamic='force-dynamic'
export const maxDuration=1800
type Context={params:Promise<{id:string}>}
export async function GET(request:Request,context:Context){try{requireRole(await getSessionFromCookie(),['admin']);return NextResponse.json(await remoteServiceHistory((await context.params).id),{headers:{'Cache-Control':'no-store'}})}catch(error){return jsonError(error)}}
export async function POST(request:Request,context:Context){try{
  const user=await getSessionFromCookie();requireRole(user,['admin']);requireSameOrigin(request);const body=await readBody(request,65536),id=(await context.params).id
  const result=await updateProtected('Remote service operation',async()=>{
    if(body.action==='review')return reviewRemoteService(id,body,user!.id)
    if(body.action==='install')return installRemoteService(id,body,user!.id)
    if(body.action==='recover')return recoverRemoteService(id,body,user!.id)
    if(body.action==='credentials')return remoteServiceCredentials(id,String(body.operationId),user!.id)
    throw new ApiError('Unknown service operation',400)
  });return NextResponse.json(result,{headers:{'Cache-Control':'no-store'}})
}catch(error){return jsonError(error)}}
