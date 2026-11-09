import {NextResponse} from 'next/server'
import {ApiError,jsonError} from '@/lib/api'
import {getSessionFromCookie} from '@/lib/auth'
import {requireRole} from '@/lib/rbac'
import {readBody,requireSameOrigin} from '@/lib/request-body'
import {query} from '@/lib/db'
import {decryptSecret} from '@/lib/secret-crypto'
import {serverDetail} from '@/lib/managed-servers'
import {resourceTransaction} from '@/lib/remote-resources'
import {remoteStorageConnections,remoteStorageServices,remoteStorageDetail,remoteStorageOperation,createRemoteStorageConnection,changeRemoteStorageConnection,createRemoteStorageService,changeRemoteStorageService,remoteStorageService,remoteStorageUrl,saveRemoteStorageSchedule} from '@/lib/remote-storage'
import {updateProtected} from '@/lib/update-maintenance'
import {syncRemoteStorageEnvironment} from '@/lib/remote-storage'
import {discoverRemoteStorage,adoptRemoteStorage} from '@/lib/remote-storage-discovery'
import {reviewRemoteStorageRename,renameRemoteStorage,listRemoteStorageRenames,reconcileRemoteStorageRename} from '@/lib/remote-storage-rename'
import {remoteStorageEngines,remoteServerDatabases,refreshRemoteStorageInventory,changeRemoteServerDatabase,restrictRemoteStorageServer} from '@/lib/remote-storage-servers'
import {reviewRemoteDedicatedUser,changeRemoteDedicatedUser} from '@/lib/remote-storage-changes'
import {reviewRemoteStorageMove,changeRemoteStorageMove,remoteStorageMove} from '@/lib/remote-storage-move'
export const dynamic='force-dynamic'
type Context={params:Promise<{id:string;path?:string[]}>}
export async function GET(request:Request,context:Context){try{
  const user=await getSessionFromCookie();requireRole(user,['admin','operator','viewer']);const {id,path=[]}=await context.params
  const route=path.join('/');let result:unknown
  if(route==='data/connections')result={connections:(await remoteStorageConnections(id)).map(c=>({...c,options:{}}))}
  else if(route==='databases/engines')result={engines:await remoteStorageEngines(id),isAdmin:user!.role==='admin'}
  else if(path[0]==='databases'&&path[1]==='servers'&&path.length===4&&path[3]==='databases'){requireRole(user,['admin']);result=await remoteServerDatabases(id,path[2])}
  else if(route==='data/services')result={services:await remoteStorageServices(id)}
  else if(route==='databases/discover')result={discovered:await discoverRemoteStorage(id,new URL(request.url).searchParams.get('project')||undefined)}
  else if(route==='databases/renames')result={renames:await listRemoteStorageRenames(id)}
  else if(path[0]==='databases'&&path[1]==='moves'&&path.length===3)result=await remoteStorageMove(id,path[2])
  else if(route==='apps'){const {apps}=await serverDetail(id);result=apps.map(app=>({...app,environment:app.environment_name}))}
  else if(path[0]==='apps'&&path.length===3&&path[2]==='data-services')result={services:await remoteStorageServices(id,path[1])}
  else if(path[0]==='apps'&&path.length===4&&path[2]==='data-services'&&path[3]==='shareable'){
    const {apps}=await serverDetail(id),app=apps.find(a=>a.id===path[1]);if(!app)throw new ApiError('Application not found',404)
    const services=await remoteStorageServices(id),own=services.filter(s=>s.project_id===app.id)
    result={services:services.filter(s=>s.project_id!==app.id&&s.status==='ready'&&app.application_group_id&&s.group_id===app.application_group_id&&s.environment===app.environment_name).map(s=>({...s,already_shared:own.some(o=>o.options.sharedFrom===s.id)}))}
  }else if(path[0]==='apps'&&path.length===3&&path[2]==='database'){await remoteStorageServices(id,path[1]);result={database:null}}
  else if(route==='databases'){
    const services=await remoteStorageServices(id),databases=[],seen=new Set<string>()
    for(const item of services){const key=[item.provider,item.host,item.port,item.database_name].join(':');if(seen.has(key))continue;seen.add(key);databases.push({key,...await remoteStorageDetail(id,item.id)})}
    result={databases,discovered:await discoverRemoteStorage(id),isAdmin:user!.role==='admin'}
  }else if(path[0]==='databases'&&path.length===2&&!['discover','renames','engines'].includes(path[1]))result={database:await remoteStorageDetail(id,path[1]),isAdmin:user!.role==='admin',canWrite:user!.role!=='viewer'}
  else throw new ApiError('This storage operation is not available on this server yet',409)
  return NextResponse.json(result,{headers:{'Cache-Control':'no-store'}})
}catch(error){return jsonError(error)}}
async function mutate(request:Request,context:Context){try{
  const user=await getSessionFromCookie(),{id,path=[]}=await context.params
  requireRole(user,request.method==='POST'&&path.length===4&&path[0]==='apps'&&path[2]==='data-services'&&path[3]==='sync-env'?['admin','operator']:['admin']);requireSameOrigin(request)
  const route=path.join('/'),body=request.headers.get('content-type')?.includes('application/json')?await readBody(request,100000):{}
  const result=await updateProtected('Remote storage admission',async()=>{
    if(route==='databases/engines/refresh'&&request.method==='POST')return refreshRemoteStorageInventory(id,user!.id)
    if(path[0]==='databases'&&path[1]==='engines'&&path.length===4&&path[3]==='restrict'&&request.method==='POST')return restrictRemoteStorageServer(id,path[2],user!.id)
    if(path[0]==='databases'&&path[1]==='servers'&&path[3]==='databases'&&(path.length===4&&request.method==='POST'||path.length===5&&request.method==='DELETE'))return changeRemoteServerDatabase(id,path[2],path[4],body,user!.id)
    if(route==='databases/adopt'&&request.method==='POST')return adoptRemoteStorage(id,String(body.projectId),body.source,user!.id)
    if(path[0]==='databases'&&path.length===3&&path[2]==='dedicated-user'&&request.method==='POST')return body.preview===true?reviewRemoteDedicatedUser(id,path[1],user!.id):changeRemoteDedicatedUser(id,path[1],body,user!.id)
    if(path[0]==='databases'&&path.length===3&&path[2]==='move'&&request.method==='POST')return body.preview===true?reviewRemoteStorageMove(id,path[1],user!.id):changeRemoteStorageMove(id,path[1],body,user!.id)
    if(path[0]==='databases'&&path.length===3&&path[2]==='rename'&&request.method==='POST')return body.preview===true?reviewRemoteStorageRename(id,path[1],user!.id):renameRemoteStorage(id,path[1],body,user!.id)
    if(path[0]==='databases'&&path[1]==='renames'&&path.length===4&&path[3]==='reconcile'&&request.method==='POST')return reconcileRemoteStorageRename(id,path[2],user!.id)
    if(route==='data/connections'&&request.method==='POST')return createRemoteStorageConnection(id,body,user!.id)
    if(path[0]==='data'&&path[1]==='connections'&&path.length===3&&request.method==='DELETE')return changeRemoteStorageConnection(id,path[2],true,user!.id)
    if(path[0]==='data'&&path[1]==='connections'&&path.length===4&&path[3]==='test'&&request.method==='POST')return changeRemoteStorageConnection(id,path[2],false,user!.id)
    if(path[0]==='apps'&&path[2]==='data-services'){
      if(path.length===4&&path[3]==='sync-env'&&request.method==='POST')return syncRemoteStorageEnvironment(id,path[1],body,user!.id)
      if(path.length===3&&request.method==='POST')return createRemoteStorageService(id,path[1],body,user!.id)
      if(path.length===4&&['DELETE','PATCH'].includes(request.method)){if(request.method==='PATCH'&&body.applicationPrimary!==true)throw new ApiError('Choose the application’s primary database',400);return changeRemoteStorageService(id,path[1],path[3],request.method==='DELETE',user!.id)}
      if(path.length===5&&path[4]==='credentials'&&request.method==='POST'){const services=await remoteStorageServices(id,path[1]);if(!services.some(s=>s.id===path[3]))throw new ApiError('Database not found in this application',404);return remoteStorageOperation(id,path[3],'rotate',body,user!.id)}
    }
    if(route==='data/backups/schedules'&&request.method==='POST')return saveRemoteStorageSchedule(id,body,user!.id)
    if(path[0]==='data'&&path[1]==='backups'&&path[2]==='schedules'&&path.length===5&&path[4]==='run'&&request.method==='POST'){
      const schedule=(await query('select service_id from remote_storage_schedules where server_id=$1 and id=$2',[id,path[3]])).rows[0];if(!schedule)throw new ApiError('Backup schedule not found',404)
      return remoteStorageOperation(id,schedule.service_id,'backup',{},user!.id)
    }
    if(path[0]==='databases'&&request.method==='POST'){
      if(path.length===3&&path[2]==='reveal')return resourceTransaction(id,async client=>{const item=await remoteStorageService(client,id,path[1]);await client.query('insert into audit_logs(user_id,action,resource,details) values($1,$2,$3,$4)',[user!.id,'remote.storage.reveal',item.id,JSON.stringify({serverId:id})]);return{url:remoteStorageUrl(item,item.password_ciphertext?decryptSecret(item.password_ciphertext):'')}})
      const operation=path.length===3&&path[2]==='data'?'tables':path.length===4&&path[2]==='data'&&['rows','sql'].includes(path[3])?path[3]:path.length===3&&['overview','stats','backups','backup','restore','test','test-proposed'].includes(path[2])?path[2]:null
      if(operation)return remoteStorageOperation(id,path[1],operation,{...Object.fromEntries(new URL(request.url).searchParams),...body},user!.id)
    }
    throw new ApiError('This storage operation is not available on this server yet',409)
  })
  return NextResponse.json(result,{headers:{'Cache-Control':'no-store'}})
}catch(error){return jsonError(error)}}
export const POST=mutate,PATCH=mutate,DELETE=mutate
