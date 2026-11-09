import {NextResponse} from 'next/server'
/** Synthetic Storage UI data. Never imports database drivers, credentials or agents. */
export async function storageFixture(request:Request,role:string){
  const url=new URL(request.url),remote=url.pathname.match(/^\/api\/servers\/([^/]+)\/storage(\/.*)?$/)
  let route=url.pathname
  if(remote){route=(remote[2]||'').replace(/^\/databases/,'/api/storage').replace(/^\/data/,'/api/data').replace(/^\/apps/,'/api/sites')}
  if(!route.startsWith('/api/storage')&&!route.startsWith('/api/data/')&&!/\/data-services(?:\/|$)/.test(route))return null
  const serverId=remote?.[1],appId=serverId?'33333333-3333-4333-8333-333333333333':'fixture-app',id='66666666-6666-4666-8666-666666666666',connectionId='77777777-7777-4777-8777-777777777777',appName=serverId?'Campus Library':'Customer portal'
  const connection={id:connectionId,name:'Application PostgreSQL',provider:'postgresql',host:'127.0.0.1',port:5433,username:'fixture_administrator',tls_enabled:false,options:{},purpose:'shared_application',managed:true,is_default:true,provisioning_enabled:true,last_status:'healthy',last_error:null,last_tested_at:new Date().toISOString(),service_count:1}
  const service={id,project_id:appId,project_name:appName,environment:'production',group_id:appId,name:'primary',database_name:'campus_library',username:'library_app',env_prefix:'PRIMARY',application_primary:true,options:{ownership:'manager'},status:'ready',connection_id:connectionId,connection_name:connection.name,provider:'postgresql',host:'127.0.0.1',port:5433,tls_enabled:false,removal_blocked_reason:null,backup_status:'success'}
  const engine={id:connectionId,name:connection.name,engine:'postgresql',host:'127.0.0.1',port:5433,role:'apps',provisioning:true,status:'healthy',version:'18.3',listen:'localhost',localOnly:true,remoteRules:0,ssl:false,pendingRestart:false,databaseCount:3,sizeBytes:12582912,linkedCount:1,warnings:[]}
  const database={key:id,id,database:'campus_library',engine:'postgresql',serverId:connectionId,serverName:connection.name,serverRole:'apps',host:'127.0.0.1',port:5433,sizeBytes:12582912,tableCount:2,ownership:'manager',warnings:[],apps:[{serviceId:id,projectId:appId,name:appName,environment:'production',groupId:appId,groupName:appName,ownership:'manager',username:'library_app'}],backup:{scheduleId:'88888888-8888-4888-8888-888888888888',frequency:'daily',timeOfDay:'03:00',timezone:'UTC',retentionCount:30,enabled:true,lastStatus:'success',lastFinishedAt:new Date().toISOString(),nextRunAt:new Date(Date.now()+86400000).toISOString()},backups:[{file:'2026-11-09T20-00-00-000Z-99999999-9999-4999-8999-999999999999.dump',serviceId:id,sizeBytes:524288,createdAt:new Date().toISOString()}]}
  const result=(body:unknown,status=200)=>NextResponse.json(body,{status})
  if(route==='/api/storage')return result({databases:[database],discovered:[],isAdmin:role==='admin'})
  if(route==='/api/storage/renames')return result({renames:[]})
  if(route==='/api/storage/discover')return result({discovered:[]})
  if(route==='/api/storage/engines')return result({engines:[engine],isAdmin:role==='admin'})
  if(route==='/api/storage/engines/refresh')return result({ok:true})
  if(route==='/api/data/connections')return result({connections:[connection]})
  if(route==='/api/data/services')return result({services:[service]})
  if(route==='/api/data/migrations')return result({migrations:[]})
  if(/\/data-services\/shareable$/.test(route))return result({services:[]})
  if(/\/data-services$/.test(route))return result({services:[service]})
  if(route===`/api/storage/servers/${connectionId}/databases`)return result({server:{id:connectionId,name:connection.name,system:false},databases:[{id,tracked:true,name:database.database,sizeBytes:database.sizeBytes,owner:'library_app',apps:[{name:appName,environment:'production'}],configuredFor:[],backup:{frequency:'daily',enabled:true,lastStatus:'success'},dropBlocker:'An application uses this database.'},{id:`server~${connectionId}~preserved_external`,tracked:false,name:'preserved_external',sizeBytes:1048576,owner:'external_owner',apps:[],configuredFor:[],backup:null,dropBlocker:'This database was not created here. Existing databases are preserved.'}]})
  if(route===`/api/storage/${id}`)return result({database,isAdmin:role==='admin',canWrite:role!=='viewer'})
  if(route.endsWith('/move')){
    const body=request.method==='GET'?{}:await request.json().catch(()=>({}))
    if(body.confirm)return result({move:{id:'99999999-9999-4999-8999-999999999999',status:'succeeded',log:'Synthetic preview only: no database or process was changed.',error:null}})
    return result({canMove:role==='admin',latest:null,plan:{review:'99999999-9999-4999-8999-999999999999',database:database.database,targetDatabase:database.database,roleName:'campus_library_app',sizeBytes:database.sizeBytes,source:{name:connection.name,port:5433,version:'18'},target:{name:'Replacement PostgreSQL',port:5434,version:'18'},extensions:[],connections:[],apps:[{projectId:appId,name:appName,environment:'production',running:true,files:[{file:'.env',changes:1}]}],minutes:{low:1,high:2},blockers:[],notes:['The original database remains unchanged. This browser preview uses synthetic data.']}})
  }
  if(route.endsWith('/rename'))return result({plan:{database:database.database,server:connection.name,apps:[{projectId:appId,name:appName,environment:'production',settings:['Manager Storage: PRIMARY']}],sessions:[{application:'library',count:3}],review:'synthetic-storage-review',blockers:['Stop every app and worker using this database first. No connections will be terminated.']}})
  if(route.endsWith('/data'))return result({tables:[{schema:'public',name:'books',est_rows:2,size_bytes:32768},{schema:'public',name:'loans',est_rows:1,size_bytes:16384}]})
  if(route.endsWith('/data/rows'))return result({columns:[{name:'id',type:'int4'},{name:'title',type:'text'}],rows:[{id:1,title:'Fixture book one'},{id:2,title:'Fixture book two'}],total:2,page:1,pageSize:50})
  if(route.endsWith('/data/sql'))return result({command:'SELECT',columns:[{name:'fixture',type:'text'}],rows:[{fixture:'Synthetic result'}],rowCount:1,durationMs:4,truncated:false})
  if(route.endsWith('/overview'))return result({ok:true,sizeBytes:database.sizeBytes,tableCount:2,backups:database.backups})
  if(route.endsWith('/backups'))return result({backups:database.backups})
  if(route.endsWith('/test'))return result({ok:true,connected:true})
  return null
}
