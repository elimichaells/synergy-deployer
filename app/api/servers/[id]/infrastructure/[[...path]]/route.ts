import { NextResponse } from 'next/server'
import { ApiError,jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { readBody,requireSameOrigin } from '@/lib/request-body'
import { serverDetail } from '@/lib/managed-servers'
import { remoteHealth } from '@/lib/remote-health'
import { queueInfrastructure,remoteInfrastructureJob,remoteProcesses } from '@/lib/remote-infrastructure'
import { updateProtected } from '@/lib/update-maintenance'
export const dynamic='force-dynamic'
type Context={params:Promise<{id:string;path?:string[]}>}
export async function GET(request:Request,context:Context){try{
  const user=await getSessionFromCookie();requireRole(user,['admin','operator','viewer'])
  const {id,path=[]}=await context.params,url=new URL(request.url)
  let value:unknown
  if(path[0]==='health')value=await remoteHealth(id,path[1]==='history'?url.searchParams.get('range')||'24h':undefined,url.searchParams.get('service')||undefined)
  else if(path[0]==='services')value=await remoteProcesses(id)
  else if(path[0]==='caddy'){const {server}=await serverDetail(id);value={...server.metrics?.caddy,status:server.status==='online'?server.metrics?.caddy?.status||'unknown':'unknown'}}
  else if(path[0]==='jobs')value=await remoteInfrastructureJob(id,path[1],user?.role==='admin')
  else throw new ApiError('Not found',404)
  return NextResponse.json(value,{headers:{'Cache-Control':'no-store'}})
}catch(error){return jsonError(error)}}
export async function POST(request:Request,context:Context){try{
  const user=await getSessionFromCookie();const {id,path=[]}=await context.params
  requireRole(user,path[0]==='services'?['admin','operator']:['admin']);requireSameOrigin(request)
  const body=path[0]==='caddy'?await readBody(request,2000):{}
  if(path[0]==='services'&&!['start','stop','restart'].includes(path[2]))throw new ApiError('Unknown process action',400)
  if(!['services','caddy'].includes(path[0]))throw new ApiError('Not found',404)
  return NextResponse.json(await updateProtected('Remote infrastructure admission',()=>queueInfrastructure(id,path[0]==='services'?path[1]:null,path[0]==='services'?path[2]:body.action,user!.id)),{status:202})
}catch(error){return jsonError(error)}}
