'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
const env=require('./database-env-rewrite.cjs');
const ownership=require('./postgres-ownership.cjs');
const ID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const FILES=['.env','.env.local','.env.production','.env.production.local'];
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const q=ownership.quoteIdent;
const literal=value=>"'"+String(value).replace(/'/g,"''")+"'";
async function database(runtime,access,work){
  const client=new runtime.pg.Client({...runtime.connection(access),application_name:'manager-database-switch'});
  client.on('error',()=>{});
  try{await client.connect();return await work(client);}finally{await client.end().catch(()=>{});}
}
async function ordinary(root,filename,h){
  const safe=await h.contained(root,path.relative(root,filename));
  const stat=await fs.lstat(safe).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(stat&&(!stat.isFile()||stat.isSymbolicLink()||stat.size>200000))throw Error('Database settings must be ordinary files no larger than 200 KB');
  return {path:safe,content:stat?await fs.readFile(safe,'utf8'):null};
}
async function writeEnvironment(root,entry,content,h){
  const current=await ordinary(root,entry.path,h);
  if(current.content!==entry.original&&current.content!==entry.content)throw Error('An environment file changed outside this operation');
  const temp=await h.contained(root,path.relative(root,entry.path+'.manager-'+require('node:crypto').randomUUID()+'.tmp'));
  try{
    const handle=await fs.open(temp,'wx',0o600);try{await handle.writeFile(content,'utf8');await handle.sync();}finally{await handle.close();}
    if((await ordinary(root,entry.path,h)).content!==current.content)throw Error('An environment file changed while saving');
    await fs.rename(temp,current.path);
  }finally{await fs.unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
async function processState(root,input,tools,h,to){
  const saved=await h.readJson(path.join(root,'apps.json'),{}),settings=await h.readJson(path.join(root,'resources.json'),{apps:{}}),list=await h.processList(tools.pm),apps=[],workers=[];
  if(!Array.isArray(input.apps)||!input.apps.length||input.apps.length>100)throw Error('Choose linked applications for this database');
  for(const requested of input.apps){
    const item=saved[requested.id];
    if(!ID.test(requested.id)||!item||item.commit!==requested.commit)throw Error('An application release changed. Refresh the database checks.');
    if(settings.apps?.[requested.id]?.sleepingSince||settings.apps?.[requested.id]?.sleepAfterMinutes)throw Error('Disable staging sleep before switching this database');
    const ecosystem=await h.contained(root,path.relative(root,item.ecosystem)),launchFile=path.join(path.dirname(ecosystem),'launch.json'),launch=await h.readJson(launchFile);
    if(!launch||typeof launch.env!=='object')throw Error('Application launch settings are missing');
    const files=[];
    for(const file of FILES){const entry=await ordinary(root,path.join(launch.cwd,file),h);if(entry.content!==null)files.push({...entry,file,...env.rewrite(entry.content,input.connection,to),original:entry.content});}
    const values=env.replacements(launch.env,input.connection,to),name=`manager-remote-${requested.id}`,status=list.find(p=>p.name===name)?.pm2_env?.status||'missing';
    if(!['online','stopped','missing'].includes(status))throw Error('Repair unhealthy applications before switching database credentials');
    if(!files.some(f=>f.changed)&&!Object.keys(values).length)throw Error(`No matching database settings were found for ${requested.name}`);
    apps.push({id:requested.id,name,app:item.app,commit:item.commit,ecosystem,launchFile,launch,definition:await fs.readFile(ecosystem,'utf8'),files,values,status,settings:settings.apps?.[requested.id]||{}});
  }
  for(const [id,config] of Object.entries(await h.readJson(path.join(root,'workers.json'),{}))){
    const app=apps.find(a=>a.id===config.projectId||path.resolve(config.workingDirectory)===path.resolve(a.launch.cwd)||path.resolve(config.workingDirectory).startsWith(path.resolve(a.launch.cwd)+path.sep));
    if(!app)continue;
    const ecosystem=await h.contained(root,'workers',id,'ecosystem.config.js'),launchFile=path.join(path.dirname(ecosystem),'launch.json'),launch=await h.readJson(launchFile),name=`manager-worker-${id}`;
    if(!ID.test(id)||!launch)throw Error('Linked worker launch settings are missing');
    const status=list.find(p=>p.name===name)?.pm2_env?.status||'missing';
    if(!['online','stopped','missing'].includes(status))throw Error('Repair unhealthy workers before switching this database');
    workers.push({id,name,ecosystem,launchFile,launch,definition:await fs.readFile(ecosystem,'utf8'),values:env.replacements(launch.env,input.connection,to),status,config});
  }
  if(Buffer.byteLength(JSON.stringify(apps.map(a=>({files:a.files,values:a.values}))))>200000)throw Error('The linked database settings exceed the 200 KB operation limit. Split the application links before switching.');
  return {apps,workers};
}
async function prepare(root,input,tools,h,runtime){
  if(!ID.test(input.operationId)||input.connection?.provider!=='postgresql'||['postgres','template0','template1'].includes(input.connection.database))throw Error('Choose an application PostgreSQL database');
  const access={...input.administrator,database:input.connection.database};
  const facts=await database(runtime,access,async client=>({
    db:(await client.query('select oid,pg_get_userbyid(datdba) as owner from pg_database where datname=current_database()')).rows[0],
    roles:(await client.query('select rolname,rolsuper from pg_roles order by rolname')).rows,
    objects:(await ownership.inventory(client)).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))
  }));
  const blockers=[];
  if(!facts.roles.find(r=>r.rolname===input.administrator.username)?.rolsuper)blockers.push('Save a PostgreSQL administrator account with permission to transfer ownership.');
  if(!facts.roles.find(r=>r.rolname===input.connection.username)?.rolsuper)blockers.push('The applications already use a non-superuser account.');
  if(facts.objects.some(o=>!o.owner_is_super&&o.owner!==input.connection.username))blockers.push('Some database objects belong to another limited account. Review their ownership first.');
  const base=(input.connection.database.toLowerCase().replace(/[^a-z0-9_]/g,'_').replace(/^(\d)/,'db_$1')||'app').slice(0,46);
  let role=base+'_app';for(let n=2;facts.roles.some(r=>r.rolname===role);n++)role=base+'_app'+n;
  const to={...input.connection,username:role,password:input.password||'review-placeholder'};
  const processes=await processState(root,input,tools,h,to);
  const review=hash({facts,processes:{apps:processes.apps.map(a=>({...a,values:undefined,files:a.files.map(f=>({path:f.path,original:f.original}))})),workers:processes.workers.map(w=>({...w,values:undefined}))},connection:input.connection,role});
  const objectKinds={};for(const o of facts.objects)objectKinds[o.kind]=(objectKinds[o.kind]||0)+1;
  return {facts,processes,to,access,review,plan:{database:input.connection.database,serverName:input.serverName,currentUser:input.connection.username,roleName:role,objectCount:facts.objects.length,objectKinds,
    apps:processes.apps.map(a=>({serviceId:input.apps.find(i=>i.id===a.id).serviceId,name:a.app.name,environment:a.app.environment_name||'production',files:[...a.files.filter(f=>f.changed).map(f=>({file:f.file,changes:f.changed})),...(Object.keys(a.values).length?[{file:'Process environment',changes:Object.keys(a.values).length}]:[])]})),
    blockers,notes:['Only the selected database changes ownership. Its data is not copied or deleted.','Running linked apps and workers restart with the new account; stopped processes remain stopped.','The agent keeps original files and ownership until the new settings pass their checks.'],review:input.operationId,agentReview:review}};
}
async function stopProcesses(tx,tools,h,continueOnError=false){
  const list=await h.processList(tools.pm);
  const errors=[];
  for(const p of [...tx.processes.workers,...tx.processes.apps])if(list.some(i=>i.name===p.name&&!['stopped','errored'].includes(i.pm2_env?.status)))try{await tools.pm(['stop',p.name]);}catch(error){if(!continueOnError)throw error;errors.push('A linked process could not be stopped');}
  if(errors.length)throw Error(errors.join('. '));
}
async function restoreProcesses(root,tx,tools,h){
  const errors=[];
  try{await stopProcesses(tx,tools,h,true);}catch{errors.push('Some linked processes could not be stopped for recovery');}
  for(const app of tx.processes.apps)for(const file of app.files.filter(f=>f.changed))try{await writeEnvironment(root,file,file.original,h);}catch{errors.push('An original environment file could not be restored');}
  for(const p of [...tx.processes.apps,...tx.processes.workers]){
    try{
      const safe=await h.contained(root,path.relative(root,p.ecosystem));await fs.writeFile(safe,p.definition,{mode:0o600});await h.atomicJson(path.join(path.dirname(safe),'launch.json'),p.launch);
      if(p.status==='online'){await tools.pm(['delete',p.name]).catch(()=>{});await tools.pm(['start',safe]);if(p.app)await h.healthy(p.app);}
    }catch{errors.push('A previous process could not be restored');}
  }
  try{await tools.pm(['save','--force']);}catch{errors.push('The restored process list could not be saved');}
  if(errors.length)throw Error(errors.join('. '));
}
async function activateProcesses(root,tx,tools,h,runtime){
  for(const app of tx.processes.apps){
    for(const entry of app.files.filter(f=>f.changed))await writeEnvironment(root,entry,entry.content,h);
    await h.atomicJson(app.launchFile,{...app.launch,env:{...app.launch.env,...app.values}});await runtime.applyLaunchSettings(root,app.id,app.ecosystem,h);
  }
  for(const worker of tx.processes.workers)await h.atomicJson(worker.launchFile,{...worker.launch,env:{...worker.launch.env,...worker.values}});
  for(const p of [...tx.processes.apps,...tx.processes.workers])if(p.status==='online'){
    await tools.pm(['delete',p.name]);await tools.pm(['start',p.ecosystem]);
    if(p.app)await h.healthy(p.app);else if(!(await h.processList(tools.pm)).some(i=>i.name===p.name&&i.pm2_env?.status==='online'))throw Error('A worker did not resume');
  }
  await tools.pm(['save','--force']);
}
async function rollbackOwnership(tx,runtime){
  await database(runtime,tx.access,async client=>{
    await client.query('begin');
    try{
      await client.query("set local lock_timeout='5s'");
      const role=(await client.query("select shobj_description(oid,'pg_authid') as marker from pg_roles where rolname=$1",[tx.to.username])).rows[0];
      if(!role){await client.query('rollback');return;}
      if(role.marker!=='manager-database-switch:'+tx.id)throw Error('The proposed database user identity changed');
      const db=(await client.query('select oid,pg_get_userbyid(datdba) as owner from pg_database where datname=current_database()')).rows[0];
      if(db.oid!==tx.facts.db.oid||![tx.to.username,tx.facts.db.owner].includes(db.owner))throw Error('The database ownership changed outside this operation');
      const current=await ownership.inventory(client);
      for(const old of tx.facts.objects){const now=current.find(o=>o.kind===old.kind&&o.schema===old.schema&&o.name===old.name&&o.args===old.args);if(!now||![old.owner,tx.to.username].includes(now.owner))throw Error('An object changed outside this operation');await client.query(ownership.ownershipStatement(old,old.owner));}
      await client.query(`alter database ${q(tx.access.database)} owner to ${q(tx.facts.db.owner)}`);
      await client.query(`drop role ${q(tx.to.username)}`);await client.query('commit');
    }catch(error){await client.query('rollback');throw error;}
  });
}
async function recover(root,tools,h,runtime){
  const active=await h.readJson(path.join(root,'database-change-active.json'));if(!active)return;
  if(!ID.test(active.id))throw Error('The database recovery journal is invalid');
  const file=await h.contained(root,'database-changes',active.id+'.json'),tx=await h.readJson(file);
  if(!tx||tx.id!==active.id)throw Error('The database recovery journal is missing');
  if(['accepted','rolled_back'].includes(tx.phase)){await fs.unlink(path.join(root,'database-change-active.json'));return;}
  // Restore every old file/process even if an ownership rollback needs review.
  let problem=false;
  try{await rollbackOwnership(tx,runtime);}catch{problem=true;}
  try{await restoreProcesses(root,tx,tools,h);}catch{problem=true;}
  if(problem){await h.atomicJson(file,{...tx,phase:'needs_review'});throw Error('The interrupted database change needs review. Original files and ownership are recorded in the agent database-changes directory.');}
  await h.atomicJson(file,{...tx,phase:'rolled_back',result:{ok:true,operationId:tx.id,rolledBack:true,steps:['Restored the previous database owners, application files and process settings.']}});
  await fs.unlink(path.join(root,'database-change-active.json'));
}
async function execute(root,input,tools,h,runtime){
  if(input.operation==='dedicated-plan')return{ok:true,plan:(await prepare(root,input,tools,h,runtime)).plan};
  const file=await h.contained(root,'database-changes',input.operationId+'.json');
  if(!ID.test(input.operationId))throw Error('Invalid database operation');
  const existing=await h.readJson(file);
  if(existing){
    if(existing.id!==input.operationId||hash(existing.connection)!==hash(input.connection))throw Error('The database journal belongs to another operation');
    if(['accepted','rolled_back'].includes(existing.phase))return existing.result;
    await recover(root,tools,h,runtime);return (await h.readJson(file)).result;
  }
  if(input.operation==='dedicated-reconcile')return{ok:true,operationId:input.operationId,rolledBack:true,steps:['The agent did not start this database change.']};
  if(input.operation!=='dedicated-user'||typeof input.password!=='string'||!/^[A-Za-z0-9_-]{32,80}$/.test(input.password))throw Error('Invalid database switch');
  const prepared=await prepare(root,input,tools,h,runtime);
  if(prepared.review!==input.agentReview)throw Error('The database, files or process state changed. Refresh the checks before switching.');
  if(prepared.plan.blockers.length)throw Error(prepared.plan.blockers.join(' '));
  for(const app of prepared.processes.apps)if(app.status==='online')await h.healthy(app.app,5000);
  const tx={id:input.operationId,connection:input.connection,...prepared,phase:'prepared'};
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await h.atomicJson(file,tx);await h.atomicJson(path.join(root,'database-change-active.json'),{id:tx.id});
  try{
    await stopProcesses(tx,tools,h);
    await database(runtime,tx.access,async client=>{
      await client.query('begin');
      try{
        await client.query("set local lock_timeout='5s'");await client.query('set local standard_conforming_strings=on');
        if((await client.query('select 1 from pg_roles where rolname=$1',[tx.to.username])).rowCount)throw Error('The proposed database user already exists');
        await client.query(`create role ${q(tx.to.username)} login password ${literal(input.password)} nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
        await client.query(`comment on role ${q(tx.to.username)} is ${literal('manager-database-switch:'+tx.id)}`);
        await client.query(`alter database ${q(tx.access.database)} owner to ${q(tx.to.username)}`);
        for(const object of tx.facts.objects)await client.query(ownership.ownershipStatement(object,tx.to.username));
        await client.query('commit');
      }catch(error){await client.query('rollback');throw error;}
    });
    await database(runtime,tx.to,async client=>{await client.query('select 1');const objects=await ownership.inventory(client);if(objects.some(o=>o.owner!==tx.to.username))throw Error('The new account does not own every application object');});
    await activateProcesses(root,tx,tools,h,runtime);
    const result={ok:true,operationId:tx.id,accepted:true,role:tx.to.username,apps:tx.processes.apps.map(a=>({id:a.id,files:a.files.filter(f=>f.changed).map(f=>f.file),keys:Object.keys(a.values)})),steps:[`Created the limited account ${tx.to.username} and transferred ${tx.facts.objects.length} database objects.`,`Verified the account can sign in to ${tx.access.database}.`,'Updated matching application and worker settings; original files are retained in the recovery journal.','Resumed the previously running processes and verified application readiness. Stopped processes remain stopped.']};
    await h.atomicJson(file,{...tx,phase:'accepted',result});await fs.unlink(path.join(root,'database-change-active.json'));return result;
  }catch{
    await recover(root,tools,h,runtime);
    return (await h.readJson(file)).result;
  }
}
module.exports={execute,recover,prepare,database,processState,stopProcesses,restoreProcesses,activateProcesses};
