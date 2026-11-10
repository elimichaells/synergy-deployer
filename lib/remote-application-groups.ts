import { randomUUID } from 'node:crypto'
import { ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { serverDetail, uuid } from '@/lib/managed-servers'
import { listRemoteDomains, listRemoteDomainRoutes, ensureRemoteDomainRoutes } from '@/lib/remote-domains'

const role=(value:unknown)=>{if(!['application','frontend','backend','service'].includes(String(value)))throw new ApiError('Choose a valid application component role',400);return String(value)}
export async function relatedRemoteApplications(serverId:string,appId:string) {
  uuid(appId)
  const {apps,jobs}=await serverDetail(serverId),app=apps.find(a=>a.id===appId)
  if(!app)throw new ApiError('Application not found on this server',404)
  const members=apps.filter(a=>a.application_group_id===app.application_group_id),ids=new Set(members.map(a=>a.id))
  return {production_id:app.production_id||app.id,application_group_id:app.application_group_id,group_name:app.group_name,component_role:app.component_role,
    members:members.map(a=>({...a,environment:a.environment_name||'production',url:a.hostname&&!a.hostname.endsWith('.invalid')?`https://${a.hostname}`:null,database_count:a.database_config?1:0,deployment_status:jobs.find(j=>j.app_id===a.id)?.status||null})),
    candidates:apps.filter(a=>!a.production_id&&!ids.has(a.id)).map(a=>({id:a.id,name:a.name,project_type:a.project_type,component_role:a.component_role})),
    domains:(await listRemoteDomains(serverId)).filter(d=>ids.has(d.project_id)&&!d.application_route),sharedDatabases:[],routes:(await listRemoteDomainRoutes(serverId)).filter(r=>ids.has(r.project_id))}
}
export async function changeRemoteApplicationGroup(serverId:string,appId:string,method:string,body:Record<string,unknown>,actor:string) {
  await serverDetail(serverId);await ensureRemoteDomainRoutes();uuid(appId)
  const client=await db.connect()
  try {
    await client.query('begin')
    if(!(await client.query("select pg_try_advisory_xact_lock(hashtext('manager-remote-domains'),hashtext($1)) as ok",[serverId])).rows[0].ok)throw new ApiError('Wait for the current domain operation before changing project membership',409)
    await client.query('select id from managed_servers where id=$1 for update',[serverId])
    const app=(await client.query('select * from remote_apps where server_id=$1 and id=$2 for update',[serverId,appId])).rows[0]
    if(!app)throw new ApiError('Application not found on this server',404)
    if((await client.query("select 1 from remote_jobs where server_id=$1 and status in ('queued','running')",[serverId])).rowCount)throw new ApiError('Wait for this server’s current operation before changing project membership',409)
    const production=app.production_id||app.id
    if(method!=='PATCH'&&(await client.query('select 1 from remote_domain_routes r join remote_domains d on d.id=r.domain_id join remote_apps t on t.id=r.project_id join remote_apps o on o.id=d.project_id where r.server_id=$1 and (t.id=$2 or t.production_id=$2 or o.id=$2 or o.production_id=$2) limit 1',[serverId,production])).rowCount)throw new ApiError('Remove shared domain paths before moving this application between projects',409)
    if(method==='PATCH'){
      const name=typeof body.name==='string'?body.name.trim():''
      if(!name||name.length>80||/[\x00-\x1f]/.test(name))throw new ApiError('Project name must be between 1 and 80 characters',400)
      await client.query('update remote_application_groups set name=$3 where server_id=$1 and id=$2',[serverId,app.application_group_id,name])
    } else if(method==='DELETE') {
      const id=randomUUID();await client.query('insert into remote_application_groups(id,server_id,name) values($1,$2,$3)',[id,serverId,app.name])
      await client.query("update remote_apps set application_group_id=$3,component_role='application' where server_id=$1 and (id=$2 or production_id=$2)",[serverId,production,id])
    } else {
      const related=uuid(body.relatedProjectId),target=(await client.query('select * from remote_apps where server_id=$1 and id=$2 for update',[serverId,related])).rows[0]
      if(!target)throw new ApiError('Related application does not belong to this server',404)
      if(target.id===app.id||target.application_group_id===app.application_group_id)throw new ApiError('These applications are already in the same project',409)
      const component=role(body.role),otherRole=role(body.relatedRole||target.component_role)
      // Move this app and its staging copy; unrelated members of its old project stay put.
      await client.query('update remote_apps set application_group_id=$3,component_role=$4 where server_id=$1 and (id=$2 or production_id=$2)',[serverId,production,target.application_group_id,component])
      await client.query('update remote_apps set component_role=$3 where server_id=$1 and (id=$2 or production_id=$2)',[serverId,target.production_id||target.id,otherRole])
    }
    await client.query('delete from remote_application_groups g where g.server_id=$1 and not exists(select 1 from remote_apps a where a.application_group_id=g.id)',[serverId])
    await client.query('insert into audit_logs(user_id,action,resource,details) values($1,$2,$3,$4)',[actor,'remote.project.'+method.toLowerCase(),appId,JSON.stringify({serverId,relatedProjectId:body.relatedProjectId||null})])
    await client.query('commit');return {ok:true}
  } catch(error){await client.query('rollback');throw error}finally{client.release()}
}
