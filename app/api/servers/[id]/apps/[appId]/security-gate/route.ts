import { NextResponse } from 'next/server'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { requireSameOrigin,readBody } from '@/lib/request-body'
import { readRemoteGate,changeRemoteGate } from '@/lib/remote-security-gate'
import { updateProtected } from '@/lib/update-maintenance'
type Context={params:Promise<{id:string;appId:string}>}
export const dynamic='force-dynamic'
export async function GET(_request:Request,context:Context){try{
  const user=await getSessionFromCookie();requireRole(user,['admin','operator','viewer']);const {id,appId}=await context.params
  return NextResponse.json({gate:await readRemoteGate(id,appId),canTurnOff:user!.role==='admin'},{headers:{'Cache-Control':'no-store'}})
}catch(error){return jsonError(error)}}
export async function POST(request:Request,context:Context){try{
  const user=await getSessionFromCookie();requireRole(user,['admin','operator']);requireSameOrigin(request);const body=await readBody(request,4000),{id,appId}=await context.params
  return NextResponse.json(await updateProtected('Remote security settings',()=>changeRemoteGate(id,appId,body,user!)))
}catch(error){return jsonError(error)}}
