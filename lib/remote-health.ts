import { db, query } from './db'
import { serverDetail } from './managed-servers'
import type { RemoteMetrics } from './managed-server-types'
import { advanceState } from '@/scripts/server-monitor-policy.cjs'
import { recordHistory, summarizeHistory } from '@/scripts/health-history.cjs'
import { INFRASTRUCTURE_CAPABILITY } from '@/scripts/manager-agent.cjs'
import { recordUptime } from '@/scripts/uptime-history.cjs'

export async function recordRemoteHealth(serverId:string,metrics:RemoteMetrics) {
  if(!metrics.capabilities?.includes(INFRASTRUCTURE_CAPABILITY))return
  const client=await db.connect()
  try {
    await client.query('begin')
    await client.query('insert into remote_health(server_id) values($1) on conflict do nothing',[serverId])
    const prior=(await client.query('select * from remote_health where server_id=$1 for update',[serverId])).rows[0]
    const at=Date.now()
    if(prior.state.checkedAt&&at-Date.parse(prior.state.checkedAt)<60000){await client.query('commit');return}
    const apps=(await client.query('select id,name,port,health_path,environment_name from remote_apps where server_id=$1 and live_commit is not null',[serverId])).rows
    const reported=new Map(metrics.apps.map(a=>[a.id,a]))
    const sample={at,disks:metrics.diskTotal&&metrics.diskFree!==null?[{name:'Application disk',total:metrics.diskTotal,free:metrics.diskFree}]:[],
      memory:{total:metrics.memoryTotal,free:metrics.memoryFree},pm2Updates:0,pm2Error:!!metrics.pm2Error,
      collectorError:metrics.proxyError||(!metrics.diskTotal?'Application disk capacity unavailable':null),
      apps:apps.map(a=>({name:`${a.name} · ${a.environment_name||'production'} · ${a.id.slice(0,8)}`,status:reported.get(a.id)?.status==='missing'?null:reported.get(a.id)?.status||null,restarts:reported.get(a.id)?.restarts||0,uptime:reported.get(a.id)?.uptime})),
      logs:apps.map(a=>({name:a.name,bytes:reported.get(a.id)?.logBytes||0})),
      checks:apps.flatMap(a=>{const check=reported.get(a.id)?.check;return check?[{...check,name:`${a.name} · ${a.environment_name||'production'} · ${a.id.slice(0,8)}`,endpoint:`http://127.0.0.1:${a.port}${a.health_path}`,expected:'HTTP 2xx'}]:[]})}
    const state=advanceState(prior.state,sample)
    for(const incident of state.incidents)incident.source='Remote server'
    await client.query('update remote_health set state=$2::jsonb,history=$3::jsonb where server_id=$1',[serverId,JSON.stringify(state),JSON.stringify(recordHistory(prior.history,sample))])
    await client.query('insert into remote_resources(server_id) values($1) on conflict do nothing',[serverId])
    const uptime=(await client.query('select uptime from remote_resources where server_id=$1 for update',[serverId])).rows[0]?.uptime
    await client.query('update remote_resources set uptime=$2 where server_id=$1',[serverId,JSON.stringify(recordUptime(uptime,sample))])
    await client.query('commit')
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
}
export async function remoteHealth(serverId:string,range?:string,service?:string) {
  const {server}=await serverDetail(serverId)
  const row=(await query('select state,history from remote_health where server_id=$1',[serverId])).rows[0]
  const unavailable=!row?.state?.checkedAt,stale=unavailable||server.status!=='online'||Date.now()-Date.parse(row.state.checkedAt)>150000
  if(range)return {...summarizeHistory(row?.history,range,service),unavailable,stale}
  return {checkedAt:row?.state?.checkedAt||null,incidents:row?.state?.incidents||[],snapshot:row?.state?.snapshot||null,unavailable,stale}
}
