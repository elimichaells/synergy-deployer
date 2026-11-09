import { NextResponse } from 'next/server'
import { ApiError, jsonError } from '@/lib/api'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { readBody, requireSameOrigin } from '@/lib/request-body'
import { serverDetail } from '@/lib/managed-servers'
import { changeDisk, queueResource, remoteDisk, remoteMemory } from '@/lib/remote-resources'
import { automationList, changeAutomation } from '@/lib/remote-automation'
import { changeOperations, remoteOperations } from '@/lib/remote-operations'
import { remoteDatabases, tuneRemoteDatabase } from '@/lib/remote-databases'
import { updateProtected } from '@/lib/update-maintenance'
export const dynamic='force-dynamic'
type Context={params:Promise<{id:string;path?:string[]}>}
export async function GET(request:Request,context:Context) {try{
  const user=await getSessionFromCookie();requireRole(user,['admin','operator','viewer'])
  const {id,path=[]}=await context.params;let value:unknown
  if(path.length===1&&path[0]==='memory')value={...await remoteMemory(id),role:user!.role}
  else if(path.length===1&&path[0]==='disk')value=await remoteDisk(id,user!.role)
  else if(path.length===1&&path[0]==='operations')value=await remoteOperations(id,new URL(request.url).searchParams.get('range')||'24h',user!.role)
  else if(path.length===1&&path[0]==='apps'){const {server,apps}=await serverDetail(id);value=apps.map(a=>({id:a.id,name:a.name,project_type:a.project_type,environment:a.environment_name||'production',root_path:server.metrics?.resources?.apps.find(p=>p.id===a.id)?.cwd||''}))}
  else if(path[0]==='automation'&&path.length===2&&['cron','workers'].includes(path[1]))value=await automationList(id,path[1]==='cron'?'cron':'worker')
  else if(path[0]==='databases'&&path.length===1)value=await remoteDatabases(id,user!.role)
  else throw new ApiError('Not found',404)
  return NextResponse.json(value,{headers:{'Cache-Control':'no-store'}})
}catch(error){return jsonError(error)}}
async function mutate(request:Request,context:Context){try{
  const user=await getSessionFromCookie(),{id,path=[]}=await context.params
  const reading=path[0]==='automation'&&path[3]==='logs'||path[0]==='databases'&&path[1]==='inspect'
  requireRole(user,reading?['admin','operator','viewer']:path[0]==='disk'||path[0]==='databases'||request.method==='DELETE'?['admin']:['admin','operator']);requireSameOrigin(request)
  const body=request.headers.get('content-type')?.includes('application/json')?await readBody(request,16000):{}
  const result=await updateProtected('Remote resource admission',async()=>{
    if(path.length===1&&path[0]==='disk'&&request.method==='POST')return changeDisk(id,body,user!.id)
    if(path.length===1&&path[0]==='operations'&&request.method==='POST')return changeOperations(id,body,user!.id,user!.role)
    if(path[0]==='automation'&&['cron','workers'].includes(path[1])&&path.length<=4){const action=request.method==='DELETE'?'delete':path[3]||'save';return changeAutomation(id,path[1]==='cron'?'cron':'worker',path[2],action,body,user!.id)}
    if(path[0]==='apps'&&path.length===3&&request.method==='POST'){
      if(!['memory','start-method','sleep','wake'].includes(path[2]))throw new ApiError('Not found',404)
      const {apps}=await serverDetail(id),app=apps.find(a=>a.id===path[1]);if(!app)throw new ApiError('Application not found on this server',404)
      if(['sleep','wake'].includes(path[2])&&app.environment_name!=='staging')throw new ApiError('Only staging applications may sleep',400)
      return queueResource(id,{...body,action:path[2],id:app.id,environment:app.environment_name||'production'},user!.id)
    }
    if(path[0]==='databases'&&path[1]==='inspect'&&path.length===2)return remoteDatabases(id,user!.role,user!.id)
    if(path[0]==='databases'&&path[1]==='tune'&&path.length===2)return tuneRemoteDatabase(id,body,user!.id)
    throw new ApiError('Not found',404)
  });return NextResponse.json(result)
}catch(error){return jsonError(error)}}
export const POST=mutate, PATCH=mutate, DELETE=mutate
