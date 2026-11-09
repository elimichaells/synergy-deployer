import { NextResponse } from 'next/server'
import { jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { readBody, requireSameOrigin } from '@/lib/request-body'
import { relatedRemoteApplications, changeRemoteApplicationGroup } from '@/lib/remote-application-groups'
import { updateProtected } from '@/lib/update-maintenance'
export const dynamic='force-dynamic'
type Context={params:Promise<{id:string;appId:string}>}
export async function GET(request:Request,context:Context){try{const user=await getSessionFromCookie();requireRole(user,['admin','operator','viewer']);const {id,appId}=await context.params;return NextResponse.json({...await relatedRemoteApplications(id,appId),canWrite:user!.role!=='viewer'},{headers:{'Cache-Control':'no-store'}})}catch(error){return jsonError(error)}}
async function mutate(request:Request,context:Context){try{const user=await getSessionFromCookie();requireRole(user,['admin','operator']);requireSameOrigin(request);const {id,appId}=await context.params,body=request.method==='DELETE'?{}:await readBody(request,4000);return NextResponse.json(await updateProtected('Update remote project',()=>changeRemoteApplicationGroup(id,appId,request.method,body,user!.id)))}catch(error){return jsonError(error)}}
export const POST=mutate,PATCH=mutate,DELETE=mutate
