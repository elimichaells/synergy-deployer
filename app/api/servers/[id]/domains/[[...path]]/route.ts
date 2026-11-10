import { NextResponse } from 'next/server'
import { jsonError,ApiError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { readBody,requireSameOrigin } from '@/lib/request-body'
import { createRemoteDomain,deleteRemoteDomain,listRemoteDomains,syncRemoteDomain,listRemoteDomainRoutes,changeRemoteDomainRoute } from '@/lib/remote-domains'
import { audit } from '@/lib/audit'
import { updateProtected } from '@/lib/update-maintenance'
export const dynamic='force-dynamic'
type Context={params:Promise<{id:string;path?:string[]}>}
export async function GET(request:Request,context:Context){try{requireRole(await getSessionFromCookie(),['admin','operator','viewer']);const {id,path=[]}=await context.params,project=new URL(request.url).searchParams.get('project')||undefined;if(path.length>1||path.length===1&&path[0]!=='routes')throw new ApiError('Not found',404);return NextResponse.json(path[0]==='routes'?{routes:await listRemoteDomainRoutes(id,project)}:{domains:(await listRemoteDomains(id)).filter(d=>!project||d.project_id===project)},{headers:{'Cache-Control':'no-store'}})}catch(error){return jsonError(error)}}
async function change(request:Request,context:Context){try{
  const user=await getSessionFromCookie();requireRole(user,['admin']);requireSameOrigin(request);const {id,path=[]}=await context.params
  if(path[0]==='routes'){
    if(!(request.method==='POST'&&path.length===1||request.method==='DELETE'&&path.length===2))throw new ApiError('Not found',404)
    const body=request.method==='POST'?await readBody(request,4000):{}
    const result=await updateProtected('Remote shared domain path',()=>changeRemoteDomainRoute(id,path[1]||null,body,user!.id));await audit(user!.id,'remote.domain.route.'+request.method.toLowerCase(),path[1]||id,{serverId:id});return NextResponse.json(result)
  }
  if(path.length>1||request.method!=='POST'&&!path[0])throw new ApiError('Not found',404)
  const body=request.method==='POST'?await readBody(request,4000):{}
  const result=await updateProtected('Remote domain operation',()=>request.method==='POST'?createRemoteDomain(id,body,user!.id):request.method==='PATCH'?syncRemoteDomain(id,path[0],user!.id):deleteRemoteDomain(id,path[0],user!.id))
  await audit(user!.id,'remote.domain.'+request.method.toLowerCase(),path[0]||id,{serverId:id})
  return NextResponse.json(result)
}catch(error){return jsonError(error)}}
export const POST=change
export const PATCH=change
export const DELETE=change
