import { createHash, randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { ApiError } from './api'
import { audit } from './audit'
import { db, query } from './db'
import { ensureManagedServers, uuid } from './managed-servers'
import { encryptSecret, decryptSecret } from './secret-crypto'
import { credentialSecrets, sshTarget, sshCredentials, connectSsh, inspectConnection, sftpSession, writeRemote, powershell, sshExec, sudoCommand } from './server-ssh'
import { servicePlan, verifyServicePlan, SERVICES } from '@/scripts/remote-service-policy.cjs'
import { redact, SERVICE_TOOLS_CAPABILITY } from '@/scripts/manager-agent.cjs'
import { remoteRuntimeAsset } from './remote-runtime-catalog'
import { serviceDownloads } from './remote-service-downloads'
import {serviceUpgradeDownloads} from './service-upgrade-downloads'
import {detectedToolVersion} from './remote-tool-updates'
import type { ServerToolId } from './server-tool-catalog'
import type { RemoteServicePlan } from './remote-service-catalog'
import type { SFTPWrapper } from 'ssh2'
import type { PoolClient } from 'pg'
import type { RemoteMetrics } from './managed-server-types'
const ps=(s:string)=>"'"+s.replace(/'/g,"''")+"'",sh=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'"
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
const readRemote=(sftp:SFTPWrapper,file:string)=>new Promise<string>((resolve,reject)=>sftp.readFile(file,(e,b)=>e?reject(e):b.length>200000?reject(Error('Remote receipt is too large')):resolve(b.toString('utf8'))))
async function server(id:string){await ensureManagedServers();uuid(id);const row=(await query<{id:string;platform:string;enabled:boolean;enrolled_at:string;metrics:RemoteMetrics}>('select * from managed_servers where id=$1',[id])).rows[0];if(!row?.enabled||!row.enrolled_at)throw new ApiError('Connect this server before managing services',409);return row}
async function connectionFor(id:string,body:Record<string,unknown>){
  const row=await server(id),target=sshTarget(body),auth=sshCredentials(body)
  const selected=(body.selection as {service?:string}|undefined)?.service
  if(selected&&['sling','angular','mongodb','sqlserver','redis','phpmyadmin'].includes(selected)&&!row.metrics?.capabilities?.includes(SERVICE_TOOLS_CAPABILITY))throw new ApiError('Update this server in Agent access & updates before configuring this service.',409)
  if(body.acceptFingerprint!==true)throw new ApiError('Verify and accept this server’s SSH identity',400)
  const connection=await connectSsh(target,auth,String(body.fingerprint||''))
  return {row,target,auth,connection}
}
async function inspectManaged(connection:Awaited<ReturnType<typeof connectSsh>>,row:{id:string;platform:string},plan:RemoteServicePlan){
  const sftp=await sftpSession(connection)
  let paths:Partial<Record<ServerToolId,string>>
  try{const agent=JSON.parse(await readRemote(sftp,plan.agentRoot.replace(/\\/g,'/')+'/agent.json'));if(agent.serverId!==row.id||!agent.enrolled)throw new ApiError('Agent directory belongs to another server',409);paths=JSON.parse(await readRemote(sftp,plan.agentRoot.replace(/\\/g,'/')+'/tool-paths.json'))}finally{sftp.end()}
  const inventory=await inspectConnection(connection,row.platform,{...paths,...(['reuse','update'].includes(plan.mode)&&plan.path?{[SERVICES[plan.service].tool]:plan.path}:{})})
  if(plan.service==='phpmyadmin'&&plan.mode==='update'){const browserSftp=await sftpSession(connection);try{Object.assign(inventory,{privateBrowserHash:digest(await readRemote(browserSftp,plan.agentRoot.replace(/\\/g,'/')+'/database-browser.json'))})}finally{browserSftp.end()}}
  return {inventory,paths}
}
export async function reviewRemoteService(id:string,body:Record<string,unknown>,userId:string){
  const {row,target,auth,connection}=await connectionFor(id,body)
  try{
    const raw=body.selection as Record<string,unknown>
    let selection=servicePlan(raw?.mode==='reuse'&&!raw.path?{...raw,mode:'install'}:raw,row.platform) as RemoteServicePlan
    const {inventory}=await inspectManaged(connection,row,selection)
    if(raw?.mode==='reuse'&&!raw.path){const candidates=inventory.tools[SERVICES[selection.service].tool as ServerToolId].filter(item=>item.compatible);if(candidates.length!==1)throw new ApiError('Provide the existing executable path; discovery did not find exactly one compatible installation.',400);selection=servicePlan({...raw,path:candidates[0].path},row.platform)}
    if(selection.mode==='update'){
      if(selection.service==='phpmyadmin'){
        const sftp=await sftpSession(connection);try{const browser=JSON.parse(await readRemote(sftp,selection.agentRoot.replace(/\\/g,'/')+'/database-browser.json'));selection=servicePlan({...selection,currentVersion:browser.version},row.platform)}finally{sftp.end()}
      }else{
        const candidates=inventory.tools[SERVICES[selection.service].tool as ServerToolId].filter(item=>item.compatible&&(!selection.path||(row.platform==='win32'?item.path.toLowerCase()===selection.path.toLowerCase():item.path===selection.path)));
        if(candidates.length!==1)throw new ApiError('Provide the exact executable path to update; more than one installation may exist.',400)
        selection=servicePlan({...selection,path:candidates[0].path,currentVersion:detectedToolVersion(selection.service,candidates[0].version)},row.platform)
      }
    }
    verifyServicePlan(selection,inventory)
    const downloads=selection.mode==='update'?await serviceUpgradeDownloads(selection.service,selection.currentVersion!,selection.version,row.platform,inventory.arch,inventory.distribution):undefined
    const review=encryptSecret(JSON.stringify({selection,target,fingerprint:body.fingerprint,inventory:digest(inventory),downloads,expiresAt:Date.now()+600000}))
    await audit(userId,'remote.service.review',id,{service:selection.service,mode:selection.mode})
    return {selection,inventory,review,message:selection.mode==='update'?selection.service==='phpmyadmin'?'Replace the private browser with the verified release. Its configuration, sessions and previous release are retained; database services and sites are not restarted.':selection.service==='pm2'?'Update this agent’s private PM2 daemon. Its managed applications and workers restart briefly; stopped processes stay stopped. Other process managers, service registrations, files and database services are preserved.':'Stage and verify the selected release, preserve configuration and retain recovery files. Only the explicitly selected service may stop. Database updates require a cold backup and paused writers.':selection.mode==='reuse'?'Use the verified executable and preserve the existing service configuration.':'Install the selected service. Existing services and data will not be replaced. New databases use loopback access.'}
  }catch(error){throw new ApiError(redact((error as Error).message,credentialSecrets(auth)),400)}finally{connection.end()}
}
export async function remoteServiceHistory(id:string){await server(id);return {operations:(await query('select id,service_id,status,plan,result,log,created_at,finished_at from remote_service_operations where server_id=$1 order by created_at desc limit 20',[id])).rows}}
export async function remoteServiceCredentials(id:string,operationId:string,userId:string){
  await server(id);uuid(operationId)
  const row=(await query("select credentials_ciphertext from remote_service_operations where server_id=$1 and id=$2 and status in ('success','failed','interrupted')",[id,operationId])).rows[0]
  if(!row?.credentials_ciphertext)throw new ApiError('No managed database credential for this installation',404)
  await audit(userId,'remote.service.credentials.read',operationId,{serverId:id})
  return JSON.parse(decryptSecret(row.credentials_ciphertext))
}
export async function installRemoteService(id:string,body:Record<string,unknown>,userId:string){
  const {row,target,auth,connection}=await connectionFor(id,body)
  let operationId='',stage='',sftp:SFTPWrapper|undefined,log='',secret='',terminal=false
  let logWrites=Promise.resolve(),lastLogWrite=0
  const add=(text:string)=>{log=(log+redact(text,[...credentialSecrets(auth),secret])).slice(-100000);if(operationId&&Date.now()-lastLogWrite>1000){lastLogWrite=Date.now();const snapshot=log;logWrites=logWrites.then(async()=>{await query('update remote_service_operations set log=$2 where id=$1',[operationId,snapshot])}).catch(()=>{})}}
  try{
    const selection=servicePlan(body.selection,row.platform) as RemoteServicePlan
    const databaseUpdate=selection.mode==='update'&&['postgresql','mysql','mariadb','mongodb','redis'].includes(selection.service)
    const databaseCredential=body.databaseCredential as {username?:string;password?:string}|undefined
    if(databaseUpdate&&(body.writersPaused!==true||typeof databaseCredential?.username!=='string'||!databaseCredential.username||typeof databaseCredential.password!=='string'||!databaseCredential.password))throw new ApiError('Pause database writers and provide an existing administrator credential before applying the reviewed update.',400)
    if(databaseUpdate)secret=databaseCredential!.password!
    let review;try{review=JSON.parse(decryptSecret(String(body.review||'')))}catch{throw new ApiError('Review this installation plan first',400)}
    if(body.reviewed!==true||review.expiresAt<Date.now()||digest(review.selection)!==digest(selection)||digest(review.target)!==digest(target)||review.fingerprint!==body.fingerprint)throw new ApiError('The installation plan changed or expired. Inspect and review it again.',409)
    const {inventory,paths}=await inspectManaged(connection,row,selection);verifyServicePlan(selection,inventory)
    if(digest(inventory)!==review.inventory)throw new ApiError('The server inventory changed. Review a fresh installation plan.',409)
    const sudo=sudoCommand(auth)
    if(row.platform==='linux'&&!inventory.privileged)await sshExec(connection,sudo.prefix+'true',sudo.input)
    if(row.platform==='win32'&&!inventory.privileged)throw new ApiError('Use an elevated administrator account',400)
    const client=await db.connect()
    try{
      await client.query('begin');await client.query('select id from managed_servers where id=$1 for update',[id])
      if((await client.query("select 1 from remote_storage_changes where server_id=$1 and status in ('running','needs_review')",[id])).rowCount)throw new ApiError('Verify the pending database change in Storage before installing services',409)
      if((await client.query("select 1 from remote_jobs where server_id=$1 and status in ('queued','running')",[id])).rowCount || (await client.query("select 1 from remote_agent_updates where server_id=$1 and status in ('queued','installing','recovery_required')",[id])).rowCount || (await client.query("select 1 from remote_service_operations where server_id=$1 and status in ('running','interrupted')",[id])).rowCount)throw new ApiError('Wait for the current server operation, or recover its interrupted installation',409)
      operationId=randomUUID();if(selection.mode==='install'&&selection.port)secret=(selection.service==='sqlserver'?'Mg!A1':'')+randomBytes(36).toString('hex')
      const credentials=secret&&selection.mode==='install'?{provider:selection.service,host:'127.0.0.1',port:selection.port,username:selection.service==='redis'?'default':selection.service==='sqlserver'?'sa':selection.service==='mongodb'?'manager_provisioner':row.platform==='win32'&&selection.service!=='postgresql'?'root':'manager_provisioner',password:secret}:null
      await client.query("insert into remote_service_operations(id,server_id,user_id,service_id,status,plan,credentials_ciphertext) values($1,$2,$3,$4,'running',$5,$6)",[operationId,id,userId,selection.service,JSON.stringify({selection,target,fingerprint:body.fingerprint}),credentials?encryptSecret(JSON.stringify(credentials)):null]);await client.query('commit')
    }catch(error){await client.query('rollback');throw error}finally{client.release()}
    await audit(userId,'remote.service.install.start',id,{operationId,service:selection.service,mode:selection.mode})
    add('[service] Resolving verified installation assets. Existing services are preserved.\n')
    const downloads=selection.mode==='update'?review.downloads:selection.mode==='install-version'?{...(row.platform==='linux'?await serviceDownloads('node',row.platform,inventory.arch):{}),versionAsset:await remoteRuntimeAsset(selection.service,selection.version,row.platform,inventory.arch)}:selection.mode==='install'||row.platform==='linux'?await serviceDownloads(selection.mode==='reuse'?'node':selection.service,row.platform,inventory.arch,inventory.distribution):{}
    sftp=await sftpSession(connection)
    const home=row.platform==='win32'?await new Promise<string>((resolve,reject)=>sftp!.realpath('.',(e,p)=>e?reject(e):resolve(p))):'/tmp'
    stage=path.posix.join(home.replace(/\\/g,'/'),'manager-service-'+operationId)
    await new Promise<void>((resolve,reject)=>sftp!.mkdir(stage,{mode:0o700},e=>e?reject(e):resolve()))
    const native=stage.replace(/^\/([A-Za-z]:\/)/,'$1').replace(/\//g,'\\')
    if(row.platform==='win32')await sshExec(connection,powershell(`$account=[Security.Principal.WindowsIdentity]::GetCurrent().Name; & icacls.exe ${ps(native)} /inheritance:r /grant:r ($account+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'; if($LASTEXITCODE -ne 0){exit 1}`))
    await query('update remote_service_operations set plan=plan||$2::jsonb where id=$1',[operationId,JSON.stringify({stage})])
    const script=row.platform==='win32'?'install-remote-service.ps1':'install-remote-service.sh'
    for(const file of [script,'service-upgrade.cjs','service-upgrade-policy.cjs','service-upgrade-runner.cjs','service-upgrade-platform.cjs','service-upgrade-pm2.cjs','service-upgrade-caddy.cjs','install-database-browser.cjs','database-browser-agent.cjs','install-remote-tool.cjs','initialize-remote-database.cjs','agent-runtime-loader.cjs',...(selection.service==='sqlserver'?['install-remote-sqlserver.ps1','offline-service.ps1','installer-offline.ps1','database-service.ps1']:[]),...(row.platform==='linux'?['bootstrap-remote-service.sh']:[])])await writeRemote(sftp,stage+'/'+file,(await readFile(path.join(process.cwd(),'scripts',file),'utf8')).replace(/\r\n/g,'\n'))
    const driverName=selection.service==='postgresql'?'pg':['mysql','mariadb'].includes(selection.service)?'mysql2':selection.service==='sqlserver'?'mssql':selection.service==='redis'?'redis':'mongodb'
    const driverArchive=databaseUpdate||['mongodb','sqlserver','redis'].includes(selection.service)&&selection.mode==='install'?await (await import('../scripts/agent-postgres-runtime.cjs')).packagePostgresRuntime(process.cwd(),[driverName]):undefined
    await writeRemote(sftp,stage+'/plan.json',JSON.stringify({...selection,serverId:id,operationId,downloads,databasePassword:selection.mode==='install'?secret:undefined,databaseCredential:databaseUpdate?databaseCredential:undefined,driverArchive}))
    if(row.platform==='linux'){const asset=(downloads as {privilegedNode:{url:string;sha256:string}}).privilegedNode;await writeRemote(sftp,stage+'/privileged-node.env','NODE_URL='+sh(asset.url)+'\nNODE_SHA='+sh(asset.sha256)+'\n')}
    const command=row.platform==='win32'?powershell(`& ${ps(native+'\\'+script)} -PlanFile ${ps(native+'\\plan.json')}; exit $LASTEXITCODE`):`${inventory.privileged?'':sudo.prefix}/bin/bash ${sh(stage+'/bootstrap-remote-service.sh')} ${sh(stage)} ${sh(operationId)} ${sh(selection.service)}`
    try{await sshExec(connection,command,row.platform==='linux'&&!inventory.privileged?sudo.input:'',1200000,add)}catch(error){add('\n'+(error as Error).message)}
    const receipt=JSON.parse(await readRemote(sftp,stage+'/result.json'))
    if(!['success','failed','interrupted'].includes(receipt.status))throw new Error('Installation has not reported completion. Recover its status before running more work.')
    if(receipt.operationId!==operationId||receipt.service!==selection.service)throw new Error('Installation receipt does not match this operation');
    delete receipt.password;terminal=receipt.status!=='interrupted';await logWrites
    await query('update remote_service_operations set status=$2,result=$3,log=$4,finished_at=now() where id=$1',[operationId,receipt.status,JSON.stringify(receipt),log])
    await audit(userId,'remote.service.install.finish',id,{operationId,status:receipt.status})
    return {id:operationId,...receipt,log}
  }catch(error){
    await logWrites
    if(operationId)await query('update remote_service_operations set status=$2,log=$3 where id=$1',[operationId,stage?'interrupted':'failed',log+'\n'+redact((error as Error).message,[...credentialSecrets(auth),secret])])
    throw new ApiError(redact((error as Error).message,[...credentialSecrets(auth),secret]),error instanceof ApiError?error.status:400)
  }finally{
    if(sftp&&terminal){for(const name of ['plan.json','previous-paths.json','service-upgrade.cjs','service-upgrade-policy.cjs','service-upgrade-runner.cjs','service-upgrade-platform.cjs','service-upgrade-pm2.cjs','service-upgrade-caddy.cjs','install-remote-service.ps1','install-remote-service.sh','install-remote-tool.cjs','install-database-browser.cjs','database-browser-agent.cjs','initialize-remote-database.cjs','agent-runtime-loader.cjs','install-remote-sqlserver.ps1','offline-service.ps1','installer-offline.ps1','database-service.ps1','sql-setup.ini','chocolatey.ps1','bootstrap-remote-service.sh','privileged-node.env','result.json'])await new Promise<void>(resolve=>sftp!.unlink(stage+'/'+name,()=>resolve()));await new Promise<void>(resolve=>sftp!.rmdir(stage,()=>resolve()))}
    sftp?.end();connection.end()
  }
}
export async function recoverRemoteService(id:string,body:Record<string,unknown>,userId:string){
  const {row,target,connection,auth}=await connectionFor(id,body);let sftp:SFTPWrapper|undefined,lease:PoolClient|undefined,locked=false
  try{
    lease=await db.connect();locked=(await lease.query("select pg_try_advisory_lock(hashtext('manager-service-recovery'),hashtext($1)) as locked",[id])).rows[0].locked
    if(!locked)throw new ApiError('Another administrator is already recovering this server operation. Wait for its result.',409)
    uuid(body.operationId);const operation=(await query("select * from remote_service_operations where id=$1 and server_id=$2 and status in ('running','interrupted')",[body.operationId,id])).rows[0]
    if(!operation||digest(target)!==digest(operation.plan.target)||body.fingerprint!==operation.plan.fingerprint||!operation.plan.stage?.endsWith('manager-service-'+operation.id))throw new ApiError('Reconnect to the original installation target',409)
    sftp=await sftpSession(connection);let receipt=JSON.parse(await readRemote(sftp,operation.plan.stage+'/result.json'))
    if(receipt.operationId!==operation.id||receipt.service!==operation.service_id)throw new ApiError('Installation receipt does not match this operation',409)
    if(receipt.status==='running'){
      if(!Number.isSafeInteger(receipt.pid)||receipt.pid<2||typeof receipt.processStartedAt!=='string')throw new ApiError('Inspect the installer on the target before recovering this operation.',409)
      const root=operation.plan.selection.agentRoot,stage=operation.plan.stage
      const agent=JSON.parse(await readRemote(sftp,root.replace(/\\/g,'/')+'/agent.json'))
      if(agent.serverId!==id||!agent.enrolled)throw new ApiError('Agent directory belongs to another server',409)
      const elevated=row.platform==='linux'&&(await sshExec(connection,'id -u')).trim()==='0'
      const sudo=elevated?{prefix:'',input:''}:sudoCommand(auth)
      const command=row.platform==='win32'?powershell(`$p=Get-Process -Id ${receipt.pid} -ErrorAction SilentlyContinue; if($p -and $p.StartTime.ToUniversalTime().ToString('o') -eq ${ps(receipt.processStartedAt)}){Write-Output 'MANAGER_INSTALLER_RUNNING';exit 0}; $backup=${ps(stage+'/previous-paths.json')};if(${operation.plan.selection.mode==='update'?'$false':'$true'} -and (Test-Path -LiteralPath $backup)){$temporary=Join-Path ${ps(root)} ('tool-paths-recovery-'+[Guid]::NewGuid().ToString()+'.tmp');Copy-Item -LiteralPath $backup -Destination $temporary;Move-Item -LiteralPath $temporary -Destination ${ps(root+'/tool-paths.json')} -Force};Write-Output 'MANAGER_INSTALLER_STOPPED'`):`${sudo.prefix}/bin/bash -c ${sh(`if [ -r /proc/${receipt.pid}/stat ] && [ "$(awk '{print $22}' /proc/${receipt.pid}/stat)" = ${sh(receipt.processStartedAt)} ]; then echo MANAGER_INSTALLER_RUNNING; exit 0; fi; if [ ${sh(operation.plan.selection.mode)} != update ] && [ -f ${sh(stage+'/previous-paths.json')} ]; then temporary=$(mktemp ${sh(root+'/tool-paths-recovery.XXXXXXXX')}); cp -- ${sh(stage+'/previous-paths.json')} "$temporary"; chown manager-agent:manager-agent "$temporary"; chmod 600 "$temporary"; mv -T -- "$temporary" ${sh(root+'/tool-paths.json')}; fi; echo MANAGER_INSTALLER_STOPPED`)}`
      const output=await sshExec(connection,command,row.platform==='linux'?sudo.input:'')
      if(!output.includes('MANAGER_INSTALLER_STOPPED'))throw new ApiError('The installer is still running. Wait before recovering its result.',409)
      receipt={status:operation.plan.selection.mode==='update'?'interrupted':'failed',operationId:operation.id,service:operation.service_id,message:'Installer stopped before reporting completion. Recovery files were retained.'}
    }
    if(operation.plan.selection.mode==='update'&&receipt.status==='interrupted'){
      const selection=operation.plan.selection as RemoteServicePlan,action=String(body.recoveryAction||'verify'),database=['postgresql','mysql','mariadb','mongodb','redis'].includes(selection.service)
      if(!['verify','restore'].includes(action)||database&&(body.writersPaused!==true||action==='restore'&&body.confirmService!==selection.serviceName))throw new ApiError('Keep writers paused. To restore a cold backup, confirm the exact service name; post-upgrade data will be retained separately.',400)
      const root=selection.agentRoot,stage=operation.plan.stage,agent=JSON.parse(await readRemote(sftp,root.replace(/\\/g,'/')+'/agent.json'));if(agent.serverId!==id||!agent.enrolled)throw new ApiError('Agent directory belongs to another server',409)
      const paths=JSON.parse(await readRemote(sftp,root.replace(/\\/g,'/')+'/tool-paths.json')),elevated=row.platform==='linux'&&(await sshExec(connection,'id -u')).trim()==='0',sudo=elevated?{prefix:'',input:''}:sudoCommand(auth)
      const command=row.platform==='win32'?powershell(`& ${ps(paths.node)} ${ps(stage+'/service-upgrade-runner.cjs')} ${ps(stage+'/plan.json')} ${ps(action)};exit $LASTEXITCODE`):`${sudo.prefix}/bin/bash ${sh(stage+'/bootstrap-remote-service.sh')} ${sh(stage)} ${sh(operation.id)} ${sh(selection.service)} ${sh(action)}`
      await sshExec(connection,command,row.platform==='linux'?sudo.input:'',1200000).catch(()=>{})
      receipt=JSON.parse(await readRemote(sftp,stage+'/result.json'));if(receipt.operationId!==operation.id||receipt.service!==operation.service_id)throw new ApiError('Recovery receipt does not match this operation',409)
    }
    if(receipt.status==='interrupted'){await query("update remote_service_operations set status='interrupted',result=$2 where id=$1",[operation.id,JSON.stringify(receipt)]);return receipt}
    if(!['success','failed'].includes(receipt.status))throw new ApiError('The installer needs inspection on the target. Its data has been preserved.',409)
    delete receipt.password
    await query('update remote_service_operations set status=$2,result=$3,finished_at=now() where id=$1',[operation.id,receipt.status,JSON.stringify(receipt)])
    for(const name of ['plan.json','previous-paths.json','service-upgrade.cjs','service-upgrade-policy.cjs','service-upgrade-runner.cjs','service-upgrade-platform.cjs','service-upgrade-pm2.cjs','service-upgrade-caddy.cjs','install-remote-service.ps1','install-remote-service.sh','install-remote-tool.cjs','install-database-browser.cjs','database-browser-agent.cjs','initialize-remote-database.cjs','agent-runtime-loader.cjs','install-remote-sqlserver.ps1','offline-service.ps1','installer-offline.ps1','database-service.ps1','sql-setup.ini','chocolatey.ps1','bootstrap-remote-service.sh','privileged-node.env','result.json'])await new Promise<void>(resolve=>sftp!.unlink(operation.plan.stage+'/'+name,()=>resolve()))
    await audit(userId,'remote.service.recover',id,{operationId:operation.id,status:receipt.status});return receipt
  }catch(error){throw new ApiError(redact((error as Error).message,credentialSecrets(auth)),error instanceof ApiError?error.status:400)}finally{
    sftp?.end();connection.end()
    if(lease){if(locked){try{await lease.query("select pg_advisory_unlock(hashtext('manager-service-recovery'),hashtext($1))",[id]);lease.release()}catch{lease.release(true)}}else lease.release()}
  }
}
