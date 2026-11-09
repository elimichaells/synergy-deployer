import { randomUUID } from 'node:crypto'
import { CronExpressionParser } from 'cron-parser'
import path from 'node:path'
import type { PoolClient } from 'pg'
import { ApiError } from './api'
import { query } from './db'
import { ensureManagedServers, serverDetail, uuid } from './managed-servers'
import { admitResource, cleanupInput, enqueueResource, resourceTransaction } from './remote-resources'

const text=(v:unknown,label:string,max:number,empty=false)=>{if(typeof v!=='string'||(!empty&&!v.trim())||v.length>max||/[\0\r\n]/.test(v))throw new ApiError('Invalid '+label,400);return v.trim()}
function next(config:Record<string,unknown>) {try {if(String(config.schedule).trim().split(/\s+/).length!==5)throw Error();return CronExpressionParser.parse(String(config.schedule),{tz:String(config.timezone)}).next().toDate().toISOString()}catch{throw new ApiError('Use a valid five-field schedule and timezone',400)}}
function validate(body:Record<string,unknown>,kind:string,platform:string) {
  const c:Record<string,unknown>&{workingDirectory:string;enabled:boolean}={...body,name:text(body.name,'name',100),description:text(body.description||'','description',1000,true),command:text(body.command,'command',4000),workingDirectory:text(body.workingDirectory,'working directory',1024),enabled:body.enabled===true}
  if(typeof body.enabled!=='boolean'||!(platform==='win32'?/^[a-z]:[\\/]/i:/^\//).test(c.workingDirectory))throw new ApiError('Provide an absolute working directory on the selected server',400)
  if(kind==='cron'){if(!['laravel','php','node','python','go','custom'].includes(String(body.language)))throw new ApiError('Invalid job language',400);if(!Number.isInteger(body.timeoutSeconds)||Number(body.timeoutSeconds)<10||Number(body.timeoutSeconds)>3600)throw new ApiError('Timeout must be 10–3600 seconds',400);next(c)}
  else if(body.pm2Name&&!/^[a-zA-Z0-9_-]{1,100}$/.test(String(body.pm2Name)))throw new ApiError('Use letters, numbers, underscores and hyphens for the process label',400)
  return c
}
export async function automationList(serverId:string,kind:'cron'|'worker') {
  const {server,apps}=await serverDetail(serverId)
  const rows=(await query('select a.*,j.status as job_status,j.started_at,j.finished_at,j.log,j.result from remote_automations a left join remote_jobs j on j.id=a.last_job_id and j.server_id=a.server_id where a.server_id=$1 and a.kind=$2 order by a.created_at',[serverId,kind])).rows
  return rows.map(row=>{const c=row.config,p=server.metrics?.resources?.workers.find(w=>w.id===row.id),app=apps.find(a=>a.id===c.projectId);return{id:row.id,name:c.name,description:c.description,command:c.command,working_directory:c.workingDirectory,enabled:c.enabled,pm2_name:c.pm2Name||`manager-worker-${row.id}`,status:server.status==='online'?p?.status||'stopped':'unknown',pid:p?.pid||null,uptime:p?.uptime||null,restarts:p?.restarts||0,cpu:p?.cpu||0,memory:p?.memory||0,project_id:c.projectId||null,project_name:app?.name||null,project_type:app?.project_type||null,language:c.language,schedule:c.schedule,timezone:c.timezone,timeout_seconds:c.timeoutSeconds,next_run_at:row.next_run_at,last_started_at:row.started_at,last_finished_at:row.finished_at,last_status:['queued','running'].includes(row.job_status)?'running':row.job_status||'idle',last_exit_code:row.result?.exitCode??null,last_output:row.result?.output||row.log||null}})
}
export async function changeAutomation(serverId:string,kind:'cron'|'worker',id:string|undefined,action:string,body:Record<string,unknown>,actor:string) {
  if(id)uuid(id)
  return resourceTransaction(serverId,async client=>{
    const server=await admitResource(client,serverId)
    const row=id?(await client.query('select * from remote_automations where server_id=$1 and id=$2 and kind=$3 for update',[serverId,id,kind])).rows[0]:null
    if(id&&!row)throw new ApiError('Job or worker not found on this server',404)
    if(action==='save'){
      const config=validate({...row?.config,...body},kind,server.platform),key=id||randomUUID()
      const paths=server.platform==='win32'?path.win32:path.posix
      const within=(base:string,value:string)=>{const relative=paths.relative(base,value);return !relative||!relative.startsWith('..')&&!paths.isAbsolute(relative)}
      const live=(server.metrics?.resources?.apps||[]) as {id:string;cwd:string}[]
      if(kind==='worker'&&!config.projectId){const found=live.find(a=>a.cwd&&within(a.cwd,config.workingDirectory));if(found)config.projectId=found.id}
      if(config.projectId&&!(await client.query('select 1 from remote_apps where server_id=$1 and id=$2',[serverId,uuid(config.projectId)])).rowCount)throw new ApiError('Application does not belong to this server',400)
      delete config.projectRoot
      if(config.projectId){const current=live.find(a=>a.id===config.projectId)?.cwd,previous=row?.config?.projectId===config.projectId?row.config.projectRoot:null;if(previous&&within(previous,config.workingDirectory))config.projectRoot=previous;else if(current&&within(current,config.workingDirectory))config.projectRoot=current}
      if(kind==='worker') {
        const job=await enqueueResource(client,serverId,{action:'worker-save',id:key,config},actor,key)
        // Reserve the identity before dispatch. A process started just before an
        // agent crash remains visible and controllable even without its receipt.
        await client.query("insert into remote_automations(id,server_id,kind,config,last_job_id) values($1,$2,'worker',$3,$4) on conflict(id) do update set last_job_id=$4",[key,serverId,JSON.stringify(config),job.jobId])
        return job
      }
      await client.query('insert into remote_automations(id,server_id,kind,config,next_run_at) values($1,$2,$3,$4,$5) on conflict(id) do update set config=$4,next_run_at=$5,updated_at=now()',[key,serverId,kind,JSON.stringify(config),config.enabled?next(config):null])
      await client.query('insert into audit_logs(user_id,action,resource,details) values($1,$2,$3,$4)',[actor,'remote.cron.save',key,JSON.stringify({serverId})]);return{ok:true}
    }
    if(action==='delete'&&kind==='cron'){await client.query('delete from remote_automations where id=$1 and server_id=$2',[id,serverId]);await client.query('insert into audit_logs(user_id,action,resource,details) values($1,$2,$3,$4)',[actor,'remote.cron.delete',id,JSON.stringify({serverId})]);return{ok:true}}
    if(!row||!(kind==='cron'?['run']:['start','stop','restart','delete','logs']).includes(action))throw new ApiError('Unknown automation action',400)
    const job=await enqueueResource(client,serverId,{action:`${kind}-${action}`,id,config:row.config},actor,id)
    if(action!=='logs')await client.query('update remote_automations set last_job_id=$2 where id=$1',[id,job.jobId]);return job
  })
}
export async function finishResource(client:PoolClient,serverId:string,job:{id:string;resource_action:string;resource_target:string},payload:Record<string,any>,success:boolean,result?:Record<string,any>|null) {
  if(job.resource_action==='recovery') {
    const status=success&&result?.result?.healthy?'succeeded':'failed'
    await client.query('update manager_ai_events set status=$2,details=details||$3::jsonb where id=$1 and server_id=$4',[job.id,status,JSON.stringify({message:result?.result?.message||'Recovery did not complete. Inspect this application before another attempt.'}),serverId])
    await client.query('update remote_recovery_reviews set status=$2 where job_id=$1 and server_id=$3',[job.id,status,serverId])
  }
  if(!success)return
  if(job.resource_action==='worker-save')await client.query("insert into remote_automations(id,server_id,kind,config) values($1,$2,'worker',$3) on conflict(id) do update set config=$3,updated_at=now()",[job.resource_target,serverId,JSON.stringify(payload.resource.config)])
  if(job.resource_action==='worker-delete')await client.query('delete from remote_automations where id=$1 and server_id=$2',[job.resource_target,serverId])
}
let ticking=false
export async function remoteResourceTick() {
  if(ticking)return;ticking=true
  try{
    await ensureManagedServers()
    const due=(await query("select a.id,a.server_id from remote_automations a join managed_servers s on s.id=a.server_id where a.kind='cron' and (a.config->>'enabled')::boolean and a.next_run_at<=now() and s.enabled and s.last_seen_at>now()-interval '90 seconds' order by a.next_run_at limit 10")).rows
    for(const candidate of due)try{await resourceTransaction(candidate.server_id,async client=>{await admitResource(client,candidate.server_id);const a=(await client.query('select * from remote_automations where id=$1 and next_run_at<=now() for update',[candidate.id])).rows[0];if(!a)return;const j=await enqueueResource(client,a.server_id,{action:'cron-run',id:a.id,config:a.config},null,a.id);await client.query('update remote_automations set next_run_at=$2,last_job_id=$3 where id=$1',[a.id,next(a.config),j.jobId])})}catch(error){if(!(error instanceof ApiError&&error.status===409))console.error('[Remote cron]',(error as Error).message)}
    const cleanup=(await query("select r.server_id from remote_resources r join managed_servers s on s.id=r.server_id where r.cleanup_enabled and (r.cleanup_last_at is null or r.cleanup_last_at<now()-interval '1 day') and s.enabled and s.last_seen_at>now()-interval '90 seconds' limit 5")).rows
    for(const row of cleanup)try{await resourceTransaction(row.server_id,async client=>{await admitResource(client,row.server_id);const r=(await client.query("select 1 from remote_resources where server_id=$1 and cleanup_enabled and (cleanup_last_at is null or cleanup_last_at<now()-interval '1 day') for update",[row.server_id])).rowCount;if(!r)return;await enqueueResource(client,row.server_id,await cleanupInput(client,row.server_id,'clean',true),null);await client.query('update remote_resources set cleanup_last_at=now() where server_id=$1',[row.server_id])})}catch(error){if(!(error instanceof ApiError&&error.status===409))console.error('[Remote cleanup]',(error as Error).message)}
  }finally{ticking=false}
}
