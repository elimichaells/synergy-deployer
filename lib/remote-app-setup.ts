import { randomBytes, randomUUID } from 'node:crypto'
import { db, query } from '@/lib/db'
import { ApiError } from '@/lib/api'
import { audit } from '@/lib/audit'
import { encryptSecret, decryptSecret } from '@/lib/secret-crypto'
import { getGitConnection, getGitHubConnectionToken } from '@/lib/github-connections'
import { repositoryPath } from '@/lib/git-provider-policy'
import { ensureManagedServers, uuid } from '@/lib/managed-servers'
import { validateApp, validateDatabase } from '@/scripts/manager-agent.cjs'
import { remoteEnvironmentPlan, remoteSetupChecks, REMOTE_SETUP_CAPABILITY, REMOTE_FRAMEWORKS } from '@/lib/remote-setup-policy'
import { SETUP_STEPS } from '@/lib/project-setup-policy'
import type { PoolClient } from 'pg'

function inputError(error: unknown): never { throw error instanceof ApiError ? error : new ApiError((error as Error).message,400) }
async function connection(id: string | null, repo: string) {
  if (!id) return null
  const value = await getGitConnection(uuid(id)); repositoryPath(repo,value)
  return { username: value.provider === 'github' ? 'x-access-token' : value.account_login, token: await getGitHubConnectionToken(id,false), caPem: value.ca_pem }
}
async function lockServer(client: PoolClient, serverId: string) {
  const server = (await client.query('select * from managed_servers where id=$1 for update',[serverId])).rows[0]
  if (!server?.enabled || !server.enrolled_at) throw new ApiError('Connect this server before importing applications',409)
  if (!server.metrics?.capabilities?.includes(REMOTE_SETUP_CAPABILITY)) throw new ApiError('Update this server to Manager agent 1.1.0 or later for guided setup. Download the current agent from Server access.',409)
  return server
}
async function lockApp(client: PoolClient, serverId: string, appId: string) {
  await lockServer(client,serverId)
  const app = (await client.query('select * from remote_apps where id=$1 and server_id=$2 for update',[appId,serverId])).rows[0]
  if (!app?.guided_setup) throw new ApiError('Guided application not found on this server',404)
  if ((await client.query("select id from remote_jobs where app_id=$1 and status in ('queued','running')",[appId])).rowCount) throw new ApiError('Wait for the current operation to finish, or cancel it before it starts',409)
  return app
}
async function enqueue(client: PoolClient, serverId: string, appId: string, userId: string, kind: string, payload: object) {
  const result = await client.query('insert into remote_jobs(server_id,app_id,user_id,kind,payload_ciphertext) values($1,$2,$3,$4,$5) returning id',[serverId,appId,userId,kind,encryptSecret(JSON.stringify(payload))])
  await client.query('update remote_apps set setup_completed_at=null where id=$1',[appId])
  return result.rows[0].id as string
}

export async function importRemoteApp(serverId: string, body: Record<string, unknown>, userId: string) {
  await ensureManagedServers(); uuid(serverId)
  let plan, template
  try {
    plan = remoteEnvironmentPlan(body.environmentMode,String(body.branch || 'main'),String(body.stagingBranch || body.branch || 'main'))
    template = validateApp({name:body.name,repo_url:body.repo_url,branch:body.branch,port:3000,start_cmd:'npm start',access_mode:'lan',hostname:'draft.invalid'})
    for (const item of plan) validateApp({...template,branch:item.branch})
  } catch (error) { inputError(error) }
  const connectionId = body.git_connection_id ? uuid(body.git_connection_id) : null
  const git = await connection(connectionId,template.repo_url)
  const client=await db.connect(), apps: {id:string;environment:string}[]=[]
  try {
    await client.query('begin'); await lockServer(client,serverId)
    const ports = new Set<number>((await client.query('select port,ip_port from remote_apps where server_id=$1',[serverId])).rows.flatMap(row=>[row.port,row.ip_port]).filter(Boolean))
    let nextPort=3000
    for (const item of plan) {
      while (ports.has(nextPort) || [2019,2029].includes(nextPort)) nextPort++
      if (nextPort>65535) throw new ApiError('No application ports are available',409)
      ports.add(nextPort)
      const id=randomUUID(), app={...template,id,branch:item.branch,port:nextPort,hostname:`app-${id}.invalid`}
      await client.query(`insert into remote_apps(id,server_id,name,repo_url,branch,install_cmd,build_cmd,start_cmd,port,access_mode,hostname,git_connection_id,env_ciphertext,environment_name,production_id,guided_setup)
        values($1,$2,$3,$4,$5,'','','npm start',$6,'lan',$7,$8,$9,$10,$11,true)`,
      [id,serverId,app.name,app.repo_url,app.branch,app.port,app.hostname,connectionId,encryptSecret('{}'),item.environment,item.environment==='staging' && apps[0]?.environment==='production' ? apps[0].id : null])
      await enqueue(client,serverId,id,userId,'inspect',{...app,environment:{},git})
      apps.push({id,environment:item.environment})
    }
    await client.query('commit')
  } catch(error) { await client.query('rollback'); throw error } finally { client.release() }
  await audit(userId,'remote.app.import',apps[0].id,{serverId,environments:apps.map(item=>item.environment)})
  return {id:apps[0].id,apps}
}

export async function remoteSetup(serverId: string, appId: string) {
  await ensureManagedServers(); uuid(serverId); uuid(appId)
  const app=(await query(`select id,server_id,name,repo_url,branch,install_cmd,build_cmd,start_cmd,port,health_path,access_mode,hostname,ip_address,ip_port,git_connection_id,
    env_names,environment_name,production_id,project_type,guided_setup,setup_step,setup_decisions,inspection,setup_completed_at,database_config from remote_apps where id=$1 and server_id=$2`,[appId,serverId])).rows[0]
  if (!app?.guided_setup) throw new ApiError('Guided application not found on this server',404)
  const related=(await query('select id,name,environment_name,setup_completed_at from remote_apps where server_id=$1 and (id=$2 or production_id=$2) order by environment_name',[serverId,app.production_id || app.id])).rows
  const jobs=(await query('select id,kind,status,log,created_at,finished_at from remote_jobs where server_id=$1 and app_id=$2 order by created_at desc limit 10',[serverId,appId])).rows
  return {app,related,jobs,checks:remoteSetupChecks(app as Parameters<typeof remoteSetupChecks>[0])}
}

export async function remoteSetupEnvironment(serverId: string, appId: string) {
  await ensureManagedServers(); uuid(serverId); uuid(appId)
  const app=(await query('select env_ciphertext from remote_apps where id=$1 and server_id=$2 and guided_setup=true',[appId,serverId])).rows[0]
  if(!app)throw new ApiError('Application not found',404)
  return {environment:JSON.parse(decryptSecret(app.env_ciphertext))}
}

export async function changeRemoteSetup(serverId: string, appId: string, body: Record<string, unknown>, userId: string) {
  await ensureManagedServers(); uuid(serverId); uuid(appId)
  // Credential resolution does not hold a database transaction open.
  const before=(await query('select repo_url,git_connection_id from remote_apps where id=$1 and server_id=$2',[appId,serverId])).rows[0]
  if(!before)throw new ApiError('Application not found',404)
  const git=body.action==='inspect'?await connection(before.git_connection_id,before.repo_url):null
  const client=await db.connect()
  let jobId:string|undefined
  try {
    await client.query('begin')
    const app=await lockApp(client,serverId,appId)
    const decisions={...app.setup_decisions}
    if(body.action==='progress') {
      if(!SETUP_STEPS.includes(body.step as typeof SETUP_STEPS[number]))throw new ApiError('Invalid setup step',400)
      await client.query('update remote_apps set setup_step=$2 where id=$1',[appId,body.step])
    } else if(body.action==='save') {
      if(!SETUP_STEPS.includes(body.step as typeof SETUP_STEPS[number]))throw new ApiError('Invalid setup step',400)
      const fields=['install_cmd','build_cmd','start_cmd','port','health_path','access_mode','hostname','ip_address','ip_port']
      const update=Object.fromEntries(fields.filter(key=>Object.hasOwn(body,key)).map(key=>[key,body[key]]))
      const environment=body.environment === undefined ? JSON.parse(decryptSecret(app.env_ciphertext)) : body.environment
      const config=validateApp({...app,...update,environment})
      const projectType=body.project_type ?? app.project_type
      if(projectType!==null && !REMOTE_FRAMEWORKS.includes(projectType))throw new ApiError('Unsupported framework',400)
      if(projectType==='angular' && app.database_config)throw new ApiError('Detach the database before choosing Angular; browser apps must use a backend API',400)
      const collisions=await client.query(`select id from remote_apps where server_id=$1 and id<>$2 and (hostname=$3 or port=$4 or port=$5 or ip_port=$4 or ip_port=$5)`,[serverId,appId,config.hostname,config.port,config.ip_port])
      if(collisions.rowCount)throw new ApiError('Hostname or port is already assigned on this server',409)
      if(body.databaseNone===true) {
        await client.query('update remote_apps set database_config=null,database_ciphertext=null where id=$1',[appId]); decisions.database='none'
      }
      if(body.environmentReviewed===true) decisions.environment='reviewed'
      if(body.domainConfigured===true) decisions.domain='configured'
      await client.query(`update remote_apps set install_cmd=$2,build_cmd=$3,start_cmd=$4,port=$5,health_path=$6,access_mode=$7,hostname=$8,ip_address=$9,ip_port=$10,
        env_ciphertext=$11,env_names=$12,project_type=$13,setup_step=$14,setup_decisions=$15::jsonb,setup_completed_at=null where id=$1`,
      [appId,config.install_cmd,config.build_cmd,config.start_cmd,config.port,config.health_path,config.access_mode,config.hostname,config.ip_address,config.ip_port,encryptSecret(JSON.stringify(config.environment)),Object.keys(config.environment).sort(),projectType,body.step,JSON.stringify(decisions)])
    } else if(body.action==='inspect') {
      if(app.repo_url!==before.repo_url || app.git_connection_id!==before.git_connection_id)throw new ApiError('Repository changed; retry inspection',409)
      const config=validateApp({...app,branch:body.branch ?? app.branch,start_cmd:app.start_cmd || 'npm start',environment:{}})
      jobId=await enqueue(client,serverId,appId,userId,'inspect',{...config,id:appId,git})
      await client.query("update remote_apps set inspection=null,branch=$2,setup_step='repository' where id=$1",[appId,config.branch])
    } else if(body.action==='database') {
      if(!app.project_type || app.project_type==='angular')throw new ApiError('Choose a backend framework first; browser apps must use a backend API',400)
      let database
      if(body.mode==='retry') {
        if(!app.database_ciphertext)throw new ApiError('No saved database connection to test',400)
        database={...JSON.parse(decryptSecret(app.database_ciphertext)),mode:'existing'}
      } else {
        if(app.database_config && body.mode==='create')throw new ApiError('This app already has a database attempt. Test its saved connection or explicitly detach it first.',409)
        const suffix=appId.replaceAll('-','').slice(0,24)
        database=validateDatabase({...body,...(body.mode==='create'?{database:`app_${suffix}`,username:`app_${suffix}`,password:randomBytes(32).toString('base64url')}: {})})
      }
      const {password,adminPassword,adminUsername,...publicConfig}=database
      // The app credential survives interrupted creation; administrator credentials live only in the encrypted job payload.
      await client.query('update remote_apps set database_config=$2::jsonb,database_ciphertext=$3,setup_decisions=setup_decisions||\'{"database":"pending"}\'::jsonb where id=$1',
      [appId,JSON.stringify({...publicConfig,status:'pending'}),encryptSecret(JSON.stringify({...publicConfig,password,mode:'existing'}))])
      jobId=await enqueue(client,serverId,appId,userId,'database',{id:appId,database})
    } else if(body.action==='validate') {
      const checks=remoteSetupChecks(app)
      if(checks.some(check=>check.status==='fail'))throw new ApiError(checks.filter(check=>check.status==='fail').map(check=>check.label).join('; '),409)
      const database=app.database_config?.status==='ready' && app.database_ciphertext ? JSON.parse(decryptSecret(app.database_ciphertext)) : null
      jobId=await enqueue(client,serverId,appId,userId,'validate',{...validateApp({...app,environment:{}}),id:appId,project_type:app.project_type,packageManager:app.inspection?.packageManager,database})
    } else throw new ApiError('Unknown setup action',400)
    await client.query('commit')
  } catch(error) { await client.query('rollback'); inputError(error) } finally { client.release() }
  await audit(userId,`remote.setup.${body.action}`,appId,{serverId,...(jobId?{jobId}:{}),...(body.step?{step:body.step}:{})})
  return {ok:true,...(jobId?{jobId}:{})}
}
