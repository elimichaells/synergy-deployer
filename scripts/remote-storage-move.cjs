'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
const common=require('./remote-storage-switch.cjs'),ownership=require('./postgres-ownership.cjs'),copy=require('./postgres-copy.cjs');
const q=ownership.quoteIdent,literal=value=>"'"+String(value).replace(/'/g,"''")+"'",hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const marker=id=>'manager-database-move:'+id;
async function connect(runtime,d){const client=new runtime.pg.Client({...runtime.connection(d),application_name:'manager-database-move',statement_timeout:1800000});client.on('error',()=>{});await client.connect();return client;}
async function inspect(runtime,d,work){const c=await connect(runtime,d);try{return await work(c);}finally{await c.end().catch(()=>{});}}
async function prepare(root,input,tools,h,runtime){
  if(!ID.test(input.operationId)||input.connection?.provider!=='postgresql'||['postgres','template0','template1'].includes(input.connection.database))throw Error('Choose an application PostgreSQL database');
  const source={...input.administrator,database:input.connection.database},blockers=[],names=[];
  const facts=await inspect(runtime,source,async c=>({db:(await c.query('select oid,pg_get_userbyid(datdba) as owner,pg_database_size(oid)::text as size from pg_database where datname=current_database()')).rows[0],version:(await c.query("select current_setting('server_version_num') as version")).rows[0].version,extensions:(await c.query("select e.extname as name,n.nspname as schema from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname<>'plpgsql' order by 1")).rows,objects:await ownership.inventory(c)}));
  let destination=null,role='',database=input.connection.database;
  if(!input.target)blockers.push('Add another verified PostgreSQL administrator connection on this server first.');
  else{
    if(input.target.host===source.host&&input.target.port===source.port)blockers.push('Choose a different PostgreSQL server for the move.');
    destination=await inspect(runtime,input.target,async c=>({version:(await c.query("select current_setting('server_version_num') as version")).rows[0].version,roles:(await c.query('select rolname from pg_roles order by rolname')).rows.map(r=>r.rolname),databases:(await c.query('select datname from pg_database order by datname')).rows.map(r=>r.datname),extensions:(await c.query('select name from pg_available_extensions')).rows.map(r=>r.name),admin:(await c.query('select rolsuper from pg_roles where rolname=current_user')).rows[0].rolsuper}));
    if(!destination.admin)blockers.push('The target connection needs a PostgreSQL administrator to create the destination and extensions.');
    if(Number(destination.version)<Math.floor(Number(facts.version)/10000)*10000)blockers.push('The destination PostgreSQL major version is older than the source.');
    const absent=facts.extensions.filter(e=>!destination.extensions.includes(e.name));if(absent.length)blockers.push('Install these target extensions first: '+absent.map(e=>e.name).join(', '));
    for(let n=2;destination.databases.includes(database);n++)database=input.connection.database.slice(0,54)+'_'+n;
    const base=input.connection.database.toLowerCase().replace(/[^a-z0-9_]/g,'_').replace(/^(\d)/,'db_$1').slice(0,44)||'app';role=base+'_app';for(let n=2;destination.roles.includes(role);n++)role=base+'_app'+n;
  }
  const paths=await h.readJson(path.join(root,'tool-paths.json'),{}),dump=paths.pg_dump||'pg_dump',restore=paths.pg_restore||'pg_restore';
  try{const version=await h.run(dump,['--version'],{timeout:10000});if(Number(version.match(/\b(\d+)\./)?.[1]||0)<Math.floor(Number(facts.version)/10000))blockers.push('Update pg_dump to the source PostgreSQL major version or later.');await h.run(restore,['--version'],{timeout:10000});}catch{blockers.push('Install or register PostgreSQL backup and restore tools.');}
  const space=await fs.statfs(root);if(Number(space.bavail)*Number(space.bsize)<Number(facts.db.size)*2+1024**3)blockers.push('There is not enough free disk space for a verified database copy.');
  const to={...(input.target||input.connection),database,username:role||'move_preview',password:input.password||'review-placeholder'},processes=await common.processState(root,input,tools,h,to);
  const review=hash({facts,destination,processes:{apps:processes.apps.map(a=>({...a,values:undefined,files:a.files.map(f=>({path:f.path,original:f.original}))})),workers:processes.workers.map(w=>({...w,values:undefined}))},connection:input.connection,target:input.target,database,role});
  for(const a of processes.apps)names.push(a.app.name);
  const size=Number(facts.db.size),gb=size/1024**3;
  return{facts,source,to,processes,review,dump,restore,plan:{review:input.operationId,agentReview:review,database:input.connection.database,targetDatabase:database,roleName:role,sizeBytes:size,source:{name:input.serverName,port:source.port,version:String(Math.floor(Number(facts.version)/10000))},target:input.target?{name:input.targetName,port:input.target.port,version:String(Math.floor(Number(destination.version)/10000))}:null,extensions:facts.extensions,connections:[],apps:processes.apps.map(a=>({projectId:a.id,name:a.app.name,environment:a.app.environment_name||'production',running:a.status==='online',files:a.files.filter(f=>f.changed).map(f=>({file:f.file,changes:f.changed}))})),minutes:{low:Math.max(1,Math.round(gb*1.2+.5)),high:Math.max(2,Math.round(gb*3+1))},blockers,notes:[`${names.join(', ')} and linked workers pause while the database is copied. Stopped processes stay stopped.`,'The original database and its data remain unchanged.','A private backup and recovery journal are retained until the copied database passes verification.']}};
}
async function dropOwnedCopy(tx,runtime){
  await inspect(runtime,tx.target,async c=>{
    const role=(await c.query("select oid,shobj_description(oid,'pg_authid') as marker from pg_roles where rolname=$1",[tx.to.username])).rows[0];
    const db=(await c.query('select oid,pg_get_userbyid(datdba) as owner from pg_database where datname=$1',[tx.to.database])).rows[0];
    if(!role){if(db)throw Error('The destination identity changed');return;}
    if(role.marker!==marker(tx.id))throw Error('The destination account no longer belongs to this move');
    if(db){if(db.owner!==tx.to.username||tx.targetOid&&db.oid!==tx.targetOid)throw Error('The destination database identity changed');const active=(await c.query('select 1 from pg_stat_activity where datname=$1 limit 1',[tx.to.database])).rowCount;if(active)throw Error('The destination is still in use; its copy was preserved');await c.query(`drop database ${q(tx.to.database)}`);}
    await c.query(`drop role ${q(tx.to.username)}`);
  });
}
async function recover(root,tools,h,runtime){
  const active=await h.readJson(path.join(root,'database-move-active.json'));if(!active)return;
  if(!ID.test(active.id))throw Error('Invalid database move journal');const file=await h.contained(root,'database-changes',active.id+'.json'),tx=await h.readJson(file);if(tx?.id!==active.id||tx.kind!=='move')throw Error('The database move journal is missing');
  if(['accepted','rolled_back'].includes(tx.phase)){await fs.unlink(path.join(root,'database-move-active.json'));return;}
  try{
    await common.restoreProcesses(root,tx,tools,h);await dropOwnedCopy(tx,runtime);
    await h.atomicJson(file,{...tx,phase:'rolled_back',result:{ok:true,operationId:tx.id,rolledBack:true,move:{id:tx.id,status:'rolled_back',log:'Restored the original application settings. The source database is unchanged.',error:tx.failure||null}}});await fs.unlink(path.join(root,'database-move-active.json'));
  }catch{await h.atomicJson(file,{...tx,phase:'needs_review'});throw Error('The interrupted database move needs review. The original database, backup and recovery journal are preserved.');}
}
async function execute(root,input,tools,h,runtime){
  if(!ID.test(input.operationId))throw Error('Invalid database move');
  if(input.operation==='move-plan')return{ok:true,canMove:true,plan:(await prepare(root,input,tools,h,runtime)).plan,latest:null};
  const file=await h.contained(root,'database-changes',input.operationId+'.json'),existing=await h.readJson(file);
  if(existing){if(existing.kind!=='move'||hash(existing.connection)!==hash(input.connection)||hash(existing.target)!==hash(input.target))throw Error('The move journal belongs to another operation');if(['accepted','rolled_back'].includes(existing.phase))return existing.result;await recover(root,tools,h,runtime);return(await h.readJson(file)).result;}
  if(input.operation==='move-reconcile')return{ok:true,operationId:input.operationId,rolledBack:true,move:{id:input.operationId,status:'rolled_back',log:'The agent did not start the move.',error:null}};
  if(input.operation!=='move'||typeof input.password!=='string'||!/^[A-Za-z0-9_-]{32,80}$/.test(input.password))throw Error('Invalid move credentials');
  const prepared=await prepare(root,input,tools,h,runtime);if(prepared.review!==input.agentReview)throw Error('The database, destination or application settings changed. Refresh the move review.');if(prepared.plan.blockers.length)throw Error(prepared.plan.blockers.join(' '));
  const tx={...prepared,id:input.operationId,kind:'move',connection:input.connection,target:input.target,phase:'prepared',targetOid:null};
  for(const a of tx.processes.apps)if(a.status==='online')await h.healthy(a.app,5000);
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await h.atomicJson(file,tx);await h.atomicJson(path.join(root,'database-move-active.json'),{id:tx.id});
  let source;
  try{
    await common.stopProcesses(tx,tools,h);source=await connect(runtime,tx.source);
    if((await source.query('select 1 from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() limit 1')).rowCount)throw Error('Another application is still connected to the source database');
    await source.query('begin isolation level repeatable read');await source.query("set local lock_timeout='5s'");
    for(const table of await copy.tables(source))await source.query(`lock table only ${q(table.schema)}.${q(table.name)} in share mode`);
    const snapshot=(await source.query('select pg_export_snapshot() as id')).rows[0].id;
    await inspect(runtime,input.target,async c=>{await c.query('begin');try{await c.query('set local standard_conforming_strings=on');await c.query(`create role ${q(tx.to.username)} login password ${literal(input.password)} nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);await c.query(`comment on role ${q(tx.to.username)} is ${literal(marker(tx.id))}`);await c.query('commit');}catch(e){await c.query('rollback');throw e;}await c.query(`create database ${q(tx.to.database)} owner ${q(tx.to.username)}`);tx.targetOid=(await c.query('select oid from pg_database where datname=$1',[tx.to.database])).rows[0].oid;await h.atomicJson(file,tx);});
    await inspect(runtime,{...input.target,database:tx.to.database},async c=>{for(const e of tx.facts.extensions){await c.query(`create schema if not exists ${q(e.schema)}`);await c.query(`create extension if not exists ${q(e.name)} with schema ${q(e.schema)}`);}});
    const backup=await h.contained(root,'database-moves',tx.id,'copy.dump');await fs.mkdir(path.dirname(backup),{recursive:true,mode:0o700});
    const flags=d=>['--no-password','--host',d.host,'--port',String(d.port),'--username',d.username,'--dbname',d.database],env=d=>({...h.baseEnv(),PGPASSWORD:d.password,PGSSLMODE:d.tls?'verify-full':'disable',PGCONNECT_TIMEOUT:'10'});
    await h.run(tx.dump,['--format=custom',...flags(tx.source),'--snapshot',snapshot,'--file',backup],{env:env(tx.source),timeout:1800000,secrets:[tx.source.password]});
    const list=copy.filterRestoreList(await h.run(tx.restore,['--list',backup],{timeout:30000}));await fs.writeFile(backup+'.list',list,{mode:0o600});
    const targetAdmin={...input.target,database:tx.to.database};await h.run(tx.restore,['--exit-on-error','--single-transaction','--no-owner','--no-privileges',...flags(targetAdmin),'--role',tx.to.username,'--use-list',backup+'.list',backup],{env:env(targetAdmin),timeout:1800000,secrets:[targetAdmin.password]});
    const before=await copy.facts(source),after=await inspect(runtime,tx.to,copy.facts);if(!copy.matches(before,after))throw Error('The copied rows, sequences or database objects did not match');
    await source.query('commit');await source.end();source=null;
    await common.activateProcesses(root,tx,tools,h,runtime);
    const result={ok:true,operationId:tx.id,accepted:true,role:tx.to.username,database:tx.to.database,oid:tx.targetOid,apps:tx.processes.apps.map(a=>({id:a.id,files:a.files.filter(f=>f.changed).map(f=>f.file),keys:Object.keys(a.values)})),move:{id:tx.id,status:'succeeded',log:'Copied and verified database rows, sequences and objects. Linked application readiness passed. The original database remains unchanged.',error:null,copy_path:backup}};
    await h.atomicJson(file,{...tx,phase:'accepted',result});await fs.unlink(path.join(root,'database-move-active.json'));return result;
  }catch(error){
    if(source){await source.query('rollback').catch(()=>{});await source.end().catch(()=>{});}
    tx.failure=h.redact?h.redact(String(error.message||'Database move failed'),[tx.connection.password,tx.source.password,tx.target.password,tx.to.password]).slice(0,1500):'The database move did not pass its checks';await h.atomicJson(file,tx);
    await recover(root,tools,h,runtime);return(await h.readJson(file)).result;
  }
}
module.exports={execute,recover,prepare};
