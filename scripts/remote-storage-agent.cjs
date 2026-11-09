'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
async function postgres(_root,_helpers){return require('pg');}
const providers=require('./remote-storage-providers.cjs');
async function driver(_root,_helpers,name,_archive){switch(name){case 'mysql2/promise':return require('mysql2/promise');case 'mssql':return require('mssql');case 'mongodb':return require('mongodb');case 'redis':return require('redis');default:throw Error('Unknown database driver');}}
const ID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const identifier=value=>{if(typeof value!=='string'||!/^[a-zA-Z_][a-zA-Z0-9_$]{0,62}$/.test(value))throw Error('Invalid database identifier');return '"'+value+'"';};
const quoted=value=>'"'+String(value).replace(/"/g,'""')+'"';
const literal=value=>"'"+String(value).replace(/'/g,"''")+"'";
const types={16:'bool',20:'int8',21:'int2',23:'int4',25:'text',114:'json',700:'float4',701:'float8',1043:'varchar',1082:'date',1114:'timestamp',1184:'timestamptz',1700:'numeric',2950:'uuid',3802:'jsonb'};
const columns=fields=>fields.map(field=>({name:field.name,type:types[field.dataTypeID]||String(field.dataTypeID)}));
function connection(value){
  if(!value||value.provider!=='postgresql'||typeof value.host!=='string'||!value.host||/[\s\0/\\]/.test(value.host)||!Number.isInteger(value.port)||value.port<1||value.port>65535||typeof value.username!=='string'||typeof value.password!=='string')throw Error('Invalid PostgreSQL connection');
  for(const field of [value.database,value.username])if(typeof field!=='string'||!field||Buffer.byteLength(field)>128||/[\0\r\n]/.test(field))throw Error('Invalid database identifier');
  return {host:value.host,port:value.port,user:value.username,password:value.password,database:value.database,ssl:value.tls?{rejectUnauthorized:true,...(value.caPem?{ca:value.caPem}:{})}:false,application_name:'manager-remote-storage',connectionTimeoutMillis:10000,statement_timeout:20000};
}
function readStatement(sql){
  let remaining=sql.trimStart();
  while(remaining.startsWith('--')||remaining.startsWith('/*')){
    if(remaining.startsWith('--')){const end=remaining.indexOf('\n');remaining=end<0?'':remaining.slice(end+1).trimStart();}
    else{let depth=1,index=2;for(;index<remaining.length&&depth;index++){if(remaining.slice(index,index+2)==='/*'){depth++;index++;}else if(remaining.slice(index,index+2)==='*/'){depth--;index++;}}if(depth)throw Error('Unclosed SQL comment');remaining=remaining.slice(index).trimStart();}
  }
  if(!/^(SELECT|WITH|EXPLAIN|SHOW|VALUES|TABLE)\b/i.test(remaining))throw Error('Choose a read query or explicitly allow writes');
}
async function queryResult(client,pg,sql,readOnly){
  if(typeof sql!=='string'||!sql.trim()||sql.length>50000||sql.includes('\0'))throw Error('SQL must contain 1–50000 characters');
  if(readOnly)readStatement(sql);
  const started=Date.now();if(readOnly)await client.query('begin transaction read only');
  try{
    const query=new pg.Query({text:sql,queryMode:'extended'}),rows=[];let bytes=0,total=0,truncated=false;
    const result=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{client.connection?.stream?.destroy();reject(Error('Database query timed out'));},25000);
      query.on('row',row=>{total++;const length=Buffer.byteLength(JSON.stringify(row));if(rows.length<1000&&bytes+length<200000){rows.push(row);bytes+=length;}else truncated=true;});
      query.on('error',error=>{clearTimeout(timer);reject(error);});query.on('end',result=>{clearTimeout(timer);resolve(result);});
      try{client.query(query);}catch(error){clearTimeout(timer);reject(error);}
    });
    if(readOnly)await client.query('commit');
    const last=Array.isArray(result)?result.at(-1):result;
    return{command:last.command||'OK',rowCount:last.rowCount??total,columns:columns(last.fields||[]),rows,truncated,durationMs:Date.now()-started};
  }finally{if(readOnly)await client.query('rollback').catch(()=>{});}
}
async function execute(root,input,h){
  if(!ID.test(input.serviceId)&&!/^server~[a-f0-9-]{36}~[^/\\\0]{1,400}$/i.test(input.serviceId))throw Error('Invalid storage identity');
  if(input.operation==='inventory'){
    if(!Array.isArray(input.connections)||input.connections.length>100)throw Error('Invalid database inventory');
    const connections=[];
    for(const entry of input.connections){try{const result=await execute(root,{serviceId:entry.id,operation:'engine-inventory',connection:entry.connection},h);connections.push({id:entry.id,...result});}catch(error){connections.push({id:entry.id,ok:false,error:error.message});}}
    return{ok:true,connections,checkedAt:new Date().toISOString()};
  }
  if(input.operation==='overview')return {...await execute(root,{...input,operation:'stats'},h),...await execute(root,{...input,operation:'backups'},h)};
  if(input.connection?.provider!=='postgresql')return providers.execute(root,input,h,driver);
  const d=input.connection,administrative=['provision','restore','rotate','rename-plan','rename','rename-reconcile'].includes(input.operation),access=administrative?input.administrator:d;
  const config=connection(access),pg=await postgres(root,h),client=new pg.Client(config);
  client.on('error',()=>{});
  const originalQuery=client.query.bind(client);
  client.query=(...args)=>{
    if(args[0] instanceof pg.Query)return originalQuery(...args);
    let timer;return Promise.race([originalQuery(...args),new Promise((_,reject)=>{timer=setTimeout(()=>{client.connection?.stream?.destroy();reject(Error('Database query timed out'));},25000);})]).finally(()=>clearTimeout(timer));
  };
  try{
    await client.connect();let result;
    if(input.operation==='engine-inventory'){
      const settings=(await client.query("select current_setting('server_version') as version,current_setting('listen_addresses') as listen,current_setting('ssl')='on' as ssl,(select pending_restart from pg_settings where name='listen_addresses') as pending_restart")).rows[0];
      let remoteRules=null;const warnings=[];
      try{remoteRules=Number((await client.query("select count(*)::int as count from pg_hba_file_rules where type like 'host%' and auth_method<>'reject' and address not in ('127.0.0.1','::1','localhost')")).rows[0].count);}catch{warnings.push('The saved account cannot inspect network sign-in rules.');}
      const databases=(await client.query('select oid,datname as name,pg_get_userbyid(datdba) as owner,pg_database_size(oid)::text as size from pg_database where not datistemplate order by datname limit 1001')).rows;
      if(databases.length>1000)throw Error('This server has more than 1000 databases; narrow its inventory before continuing');
      result={version:settings.version,listen:settings.listen,localOnly:settings.listen.split(',').every(value=>['localhost','127.0.0.1','::1',''].includes(value.trim())),ssl:settings.ssl,pendingRestart:settings.pending_restart,remoteRules,warnings,databases:databases.map(row=>({oid:row.oid,name:row.name,owner:row.owner,sizeBytes:Number(row.size)}))};
    }else if(input.operation==='restrict'){
      if(!['127.0.0.1','localhost','::1'].includes(d.host))throw Error('Only a local PostgreSQL server can be restricted here');
      await client.query("alter system set listen_addresses='localhost'");await client.query('select pg_reload_conf()');result={restricted:true,pendingRestart:true};
    }else if(input.operation==='server-create'){
      identifier(input.database);if(['postgres','template0','template1'].includes(input.database))throw Error('This database is protected');
      if((await client.query('select 1 from pg_database where datname=$1',[input.database])).rowCount)throw Error('The database already exists. Nothing was changed.');
      let owner=d.username;
      if(input.owner){
        identifier(input.owner.username);if(typeof input.owner.password!=='string'||input.owner.password.length<12||/[\0\r\n]/.test(input.owner.password))throw Error('Invalid database owner password');
        if((await client.query('select 1 from pg_roles where rolname=$1',[input.owner.username])).rowCount)throw Error('The database owner already exists. Nothing was changed.');
        await client.query('set standard_conforming_strings=on');await client.query(`create role ${identifier(input.owner.username)} login password ${literal(input.owner.password)} nosuperuser nocreatedb nocreaterole`);owner=input.owner.username;
      }
      await client.query(`create database ${identifier(input.database)} owner ${quoted(owner)}`);await client.query(`revoke all on database ${identifier(input.database)} from public`);
      const row=(await client.query('select oid from pg_database where datname=$1',[input.database])).rows[0];result={created:true,database:input.database,oid:row.oid,...(input.owner?{owner:input.owner}:{})};
    }else if(input.operation==='server-drop'){
      if(typeof input.database!=='string'||Buffer.byteLength(input.database)>63||/[\0\r\n]/.test(input.database)||['postgres','template0','template1',d.database].includes(input.database)||!Number.isInteger(input.oid))throw Error('This database cannot be removed here');
      const row=(await client.query('select oid from pg_database where datname=$1',[input.database])).rows[0];
      if(row?.oid!==input.oid)throw Error('The database identity changed. Nothing was removed.');
      if((await client.query('select 1 from pg_stat_activity where datname=$1',[input.database])).rowCount)throw Error('The database has active clients. Nothing was removed.');
      await client.query(`drop database ${quoted(input.database)}`);result={dropped:true,database:input.database,oid:input.oid};
    }else if(input.operation==='test')result={connected:true,database:d.database};
    else if(['rename-plan','rename','rename-reconcile'].includes(input.operation)){
      if(['postgres','template0','template1'].includes(d.database))throw Error('This database is protected');
      const before=(await client.query('select oid from pg_database where datname=$1',[d.database])).rows[0];
      const sessions=(await client.query("select coalesce(nullif(application_name,''),'Unnamed database client') as application,count(*)::int as count from pg_stat_activity where datname=$1 group by application_name",[d.database])).rows;
      if(input.operation==='rename-plan'){
        if(!before)throw Error('The database no longer exists. Refresh Storage.');
        result={plan:{database:d.database,server:input.serverName,apps:input.apps||[],sessions,review:input.review,blockers:sessions.length?['Stop every app and worker using this database and close database clients first. No connections will be terminated.']:[]}};
      }else{
        identifier(input.newName);if(input.newName===d.database||['postgres','template0','template1'].includes(input.newName)||!ID.test(input.operationId))throw Error('Invalid database rename');
        const filename=await h.contained(root,'database-operations',input.operationId+'.json');await fs.mkdir(path.dirname(filename),{recursive:true,mode:0o700});
        let journal=await h.readJson(filename);
        if(input.operation==='rename'){
          if(journal)throw Error('This rename already has a recorded attempt. Verify its outcome before retrying.');
          if(!before)throw Error('The database no longer exists. Refresh Storage.');
          if(sessions.length)throw Error('The database still has active connections. Stop its apps and workers first.');
          if((await client.query('select 1 from pg_database where datname=$1',[input.newName])).rowCount)throw Error('The new database name already exists. Nothing was changed.');
          journal={oldName:d.database,newName:input.newName,oid:before.oid,host:d.host,port:d.port};await h.atomicJson(filename,journal);
          await client.query(`alter database ${quoted(d.database)} rename to ${identifier(input.newName)}`);
        }
        const after=(await client.query('select oid from pg_database where datname=$1',[input.newName])).rows[0];
        if(!journal&&input.operation==='rename-reconcile'&&before&&!after)journal={oldName:d.database,newName:input.newName,oid:before.oid,host:d.host,port:d.port};
        if(!journal||journal.oldName!==d.database||journal.newName!==input.newName||journal.host!==d.host||journal.port!==d.port)throw Error('The rename journal does not match this database');
        const renamed=after?.oid===journal.oid,unchanged=before?.oid===journal.oid&&!after;
        if(!renamed&&!unchanged)throw Error('The rename outcome needs manual review; database identities changed.');
        await h.atomicJson(filename,{...journal,renamed,verifiedAt:new Date().toISOString()});
        result={renamed,unchanged,database:renamed?input.newName:d.database,oldName:d.database,operationId:input.operationId,message:renamed?`Renamed ${d.database} to ${input.newName}. Manager links and backup schedules use the new name. Review saved environment files and external clients before restarting or redeploying the affected apps.`:'The original database name is unchanged. No Manager links were changed.'};
      }
    }
    else if(input.operation==='provision'){
      connection(d);
      if((await client.query('select 1 from pg_database where datname=$1 union all select 1 from pg_roles where rolname=$2',[d.database,d.username])).rowCount)throw Error('The database or user already exists. Existing names are never changed. Test the saved application connection to recover a previous creation.');
      await client.query('set standard_conforming_strings=on');
      await client.query(`create role ${identifier(d.username)} login password ${literal(d.password)} nosuperuser nocreatedb nocreaterole`);
      await client.query(`create database ${identifier(d.database)} owner ${identifier(d.username)}`);
      await client.query(`revoke all on database ${identifier(d.database)} from public`);
      const application=new pg.Client(connection(d));application.on('error',()=>{});
      try{await application.connect();await application.query('revoke all on schema public from public');await application.query('select 1');}finally{await application.end().catch(()=>{});}
      result={connected:true,database:d.database,username:d.username};
    }else if(input.operation==='rotate'){
      connection(d);
      const role=(await client.query('select rolsuper,rolcreatedb,rolcreaterole from pg_roles where rolname=$1',[d.username])).rows[0];
      if(!role||role.rolsuper||role.rolcreatedb||role.rolcreaterole||d.username===access.username)throw Error('Only a dedicated application account can be rotated here.');
      if(typeof input.password!=='string'||input.password.length<12||input.password.length>4096||/[\0\r\n]/.test(input.password))throw Error('Use a password of 12–4096 characters on one line');
      await client.query('set standard_conforming_strings=on');await client.query(`alter role ${identifier(d.username)} password ${literal(input.password)}`);
      const application=new pg.Client(connection({...d,password:input.password}));application.on('error',()=>{});
      try{await application.connect();await application.query('select 1');}catch(error){await client.query(`alter role ${identifier(d.username)} password ${literal(d.password)}`).catch(()=>{});throw error;}finally{await application.end().catch(()=>{});}
      result={connected:true,rotated:true};
    }else if(input.operation==='restore'){
      if(typeof input.file!=='string'||!/^[0-9TZ-]+-[a-f0-9-]{36}\.dump$/.test(input.file))throw Error('Choose a recorded backup');
      identifier(input.targetDatabase);if(input.targetDatabase===d.database)throw Error('Restore must use a new database');
      const file=await h.contained(root,'database-backups',input.serviceId,input.file),info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink())throw Error('Backup must be an ordinary file');
      const tools=await h.readJson(path.join(root,'tool-paths.json'),{});await h.run(tools.pg_restore||'pg_restore',['--list',file],{timeout:30000});
      if((await client.query('select 1 from pg_database where datname=$1',[input.targetDatabase])).rowCount)throw Error('The restore database already exists. Nothing was overwritten.');
      await client.query(`create database ${identifier(input.targetDatabase)} owner ${identifier(d.username)} template template0`);await client.query(`revoke all on database ${identifier(input.targetDatabase)} from public`);
      await h.run(tools.pg_restore||'pg_restore',['--exit-on-error','--single-transaction','--no-owner','--no-privileges','--no-password','--host',d.host,'--port',String(d.port),'--username',d.username,'--dbname',input.targetDatabase,file],{env:{...h.baseEnv(),PGPASSWORD:d.password,PGSSLMODE:d.tls?'verify-full':'disable',PGCONNECT_TIMEOUT:'10'},timeout:1800000,secrets:[d.password]});
      result={database:input.targetDatabase,restored:true,sourcePreserved:true};
    }
    else if(input.operation==='stats'){
      const row=(await client.query("select pg_database_size(current_database())::text as bytes,(select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and n.nspname not in ('pg_catalog','information_schema')) as tables,current_user as username")).rows[0];result={sizeBytes:Number(row.bytes),tableCount:row.tables,username:row.username};
    }else if(input.operation==='tables'){
      const tables=(await client.query("select n.nspname as schema,c.relname as name,greatest(c.reltuples,0)::bigint as est_rows,pg_total_relation_size(c.oid)::bigint as size_bytes,pg_size_pretty(pg_total_relation_size(c.oid)) as size_pretty from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and n.nspname not in ('pg_catalog','information_schema') order by n.nspname,c.relname limit 1000")).rows;result={tables};
    }else if(input.operation==='rows'){
      if(typeof input.schema!=='string'||typeof input.table!=='string'||input.schema.length>63||input.table.length>63)throw Error('Choose a table in this database');
      if(!(await client.query("select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relname=$2 and c.relkind in ('r','p')",[input.schema,input.table])).rowCount)throw Error('Table not found in this database');
      const page=Number(input.page)||1,pageSize=Number(input.pageSize)||50;if(!Number.isSafeInteger(page)||page<1||page>1000000||!Number.isInteger(pageSize)||pageSize<1||pageSize>200)throw Error('Invalid table page');
      const table=quoted(input.schema)+'.'+quoted(input.table),total=Number((await client.query(`select count(*)::text as count from ${table}`)).rows[0].count);
      result={...await queryResult(client,pg,`select * from ${table} limit ${pageSize} offset ${(page-1)*pageSize}`,true),total,page,pageSize};
    }else if(input.operation==='sql')result=await queryResult(client,pg,input.sql,input.allowWrites!==true);
    else if(['backups','backup'].includes(input.operation)){
      const directory=await h.contained(root,'database-backups',input.serviceId);await fs.mkdir(directory,{recursive:true,mode:0o700});
      if(input.operation==='backup'){
        const filename=await h.contained(root,'database-backups',input.serviceId,new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID()+'.dump');
        const tools=await h.readJson(path.join(root,'tool-paths.json'),{});
        await h.run(tools.pg_dump||'pg_dump',['--format=custom','--no-password','--host',d.host,'--port',String(d.port),'--username',d.username,'--dbname',d.database,'--file',filename+'.partial'],{env:{...h.baseEnv(),PGPASSWORD:d.password,PGSSLMODE:d.tls?'verify-full':'disable',PGCONNECT_TIMEOUT:'10'},timeout:1800000,secrets:[d.password]});
        const info=await fs.stat(filename+'.partial');if(!info.size)throw Error('Backup was empty');
        await h.run(tools.pg_restore||'pg_restore',['--list',filename+'.partial'],{timeout:30000});
        await fs.rename(filename+'.partial',filename);
      }
      const backups=[];for(const file of (await fs.readdir(directory)).filter(name=>/^[0-9TZ-]+-[a-f0-9-]{36}\.dump$/.test(name))){const filename=await h.contained(root,'database-backups',input.serviceId,file),info=await fs.lstat(filename);if(!info.isFile()||info.isSymbolicLink())throw Error('Backup must be an ordinary file');backups.push({file,serviceId:input.serviceId,sizeBytes:info.size,createdAt:info.mtime.toISOString()});}
      backups.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
      if(input.operation==='backup'&&Number.isInteger(input.retentionCount)&&input.retentionCount>=1&&input.retentionCount<=365){for(const old of backups.slice(input.retentionCount))await fs.unlink(await h.contained(root,'database-backups',input.serviceId,old.file));backups.splice(input.retentionCount);}
      result={backups:backups.slice(0,365)};
    }else throw Error('Unknown storage operation');
    const output={ok:true,...result};if(Buffer.byteLength(JSON.stringify(output))>280000)throw Error('Database response is too large; narrow the query');return output;
  }catch(error){
    // SQL diagnostics can contain row values. Shared infrastructure logs are
    // visible to viewers, so only a stable error code crosses that boundary.
    if(error.code)throw Error(`Database operation failed (${String(error.code).replace(/[^A-Z0-9]/gi,'').slice(0,20)}). Check the connection and query in this database.`);
    throw error;
  }finally{await client.end().catch(()=>{});}
}
module.exports={execute,queryResult,readStatement,connection};
