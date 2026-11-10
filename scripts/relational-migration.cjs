'use strict';
// Database-only migration primitives shared by the agent and its isolated labs.
// Connections never run through a shell and TLS connections verify certificates.
const crypto=require('node:crypto');
const providers=['postgresql','mysql','mariadb','sqlserver'];
const literal=value=>"'"+String(value).replace(/'/g,"''")+"'";
function quote(provider,value){if(typeof value!=='string'||!value||value.length>128||/[\0\r\n]/.test(value))throw Error('Invalid database object name');return provider==='postgresql'?'"'+value.replace(/"/g,'""')+'"':provider==='sqlserver'?'['+value.replace(/]/g,']]')+']':'`'+value.replace(/`/g,'``')+'`';}
const object=(d,schema,table)=>quote(d.provider,schema)+'.'+quote(d.provider,table);
const schema=d=>d.provider==='postgresql'?'public':d.provider==='sqlserver'?'dbo':d.database;
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function session(d,driver,work){
  if(!d||!providers.includes(d.provider)||typeof d.host!=='string'||!d.host||/[\s/\\\0]/.test(d.host)||!Number.isInteger(d.port)||d.port<1||d.port>65535||typeof d.username!=='string'||typeof d.password!=='string')throw Error('Invalid migration connection');
  quote(d.provider,d.database);
  const config={host:d.host,port:d.port,user:d.username,password:d.password,database:d.database};let client,query,close,begin,commit,rollback;
  if(d.provider==='postgresql'){
    const pg=await driver('pg');client=new pg.Client({...config,ssl:d.tls?{rejectUnauthorized:true,...(d.caPem?{ca:d.caPem}:{})}:false,connectionTimeoutMillis:10000,statement_timeout:1800000,application_name:'manager-data-migration'});client.on('error',()=>{});await client.connect();query=async sql=>(await client.query(sql)).rows;close=()=>client.end();begin=()=>query('begin');commit=()=>query('commit');rollback=()=>query('rollback');
  }else if(d.provider==='mysql'||d.provider==='mariadb'){
    const mysql=await driver('mysql2/promise');client=await mysql.createConnection({...config,ssl:d.tls?{rejectUnauthorized:true,...(d.caPem?{ca:d.caPem}:{})}:undefined,connectTimeout:10000,supportBigNumbers:true,bigNumberStrings:true});query=async sql=>(await client.query({sql,timeout:1800000}))[0];close=()=>client.end();begin=()=>client.beginTransaction();commit=()=>client.commit();rollback=()=>client.rollback();
  }else{
    const sql=await driver('mssql');client=await new sql.ConnectionPool({server:d.host,port:d.port,user:d.username,password:d.password,database:d.database,connectionTimeout:10000,requestTimeout:1800000,options:{encrypt:d.tls===true,trustServerCertificate:!d.tls},pool:{max:1,min:0}}).connect();let transaction=null;
    query=async text=>(await(transaction?transaction.request():client.request()).query(text)).recordset||[];close=()=>client.close();begin=async()=>{transaction=new sql.Transaction(client);await transaction.begin();};commit=()=>transaction.commit();rollback=()=>transaction?.rollback();
  }
  try{return await work({query,begin,commit,rollback});}finally{await close().catch(()=>{});}
}
async function tables(d,driver){return session(d,driver,async c=>{
  const filter=d.provider==='postgresql'?"table_schema not in ('pg_catalog','information_schema') and table_schema not like 'pg_toast%'":d.provider==='sqlserver'?"table_schema not in ('sys','INFORMATION_SCHEMA')":'table_schema='+literal(d.database);
  const rows=await c.query(`select table_schema as schema_name,table_name from information_schema.tables where table_type='BASE TABLE' and ${filter} order by table_schema,table_name`);
  if(rows.length>10000)throw Error('Database inventory exceeds the migration inspection limit');return rows.map(r=>({schema:r.schema_name||r.SCHEMA_NAME,table:r.table_name||r.TABLE_NAME}));
});}
async function columns(c,d,schema,table){
  const fields=d.provider==='postgresql'?"is_identity,is_generated,column_default":d.provider==='sqlserver'?"column_default,COLUMNPROPERTY(OBJECT_ID(QUOTENAME(table_schema)+'.'+QUOTENAME(table_name)),column_name,'IsIdentity') as is_identity,COLUMNPROPERTY(OBJECT_ID(QUOTENAME(table_schema)+'.'+QUOTENAME(table_name)),column_name,'IsComputed') as is_computed":'column_default,extra';
  return(await c.query(`select column_name,data_type,is_nullable,${fields} from information_schema.columns where table_schema=${literal(schema)} and table_name=${literal(table)} order by ordinal_position`)).map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k.toLowerCase(),v])));
}
async function foreignKeys(d,driver){return session(d,driver,async c=>{
  let sql;
  if(d.provider==='postgresql')sql=`select ns.nspname as source_schema,t.relname as source_table,con.conname as constraint_name,a.attname as source_column,rns.nspname as target_schema,rt.relname as target_table,ra.attname as target_column,k.ordinality as position,con.confdeltype as delete_rule,con.confupdtype as update_rule from pg_constraint con join pg_class t on t.oid=con.conrelid join pg_namespace ns on ns.oid=t.relnamespace join pg_class rt on rt.oid=con.confrelid join pg_namespace rns on rns.oid=rt.relnamespace cross join lateral unnest(con.conkey,con.confkey) with ordinality as k(attnum,refnum,ordinality) join pg_attribute a on a.attrelid=t.oid and a.attnum=k.attnum join pg_attribute ra on ra.attrelid=rt.oid and ra.attnum=k.refnum where con.contype='f' order by ns.nspname,t.relname,con.conname,k.ordinality`;
  else if(d.provider==='sqlserver')sql=`select schema_name(t.schema_id) as source_schema,t.name as source_table,f.name as constraint_name,col_name(k.parent_object_id,k.parent_column_id) as source_column,schema_name(rt.schema_id) as target_schema,rt.name as target_table,col_name(k.referenced_object_id,k.referenced_column_id) as target_column,k.constraint_column_id as position,f.delete_referential_action_desc as delete_rule,f.update_referential_action_desc as update_rule from sys.foreign_keys f join sys.foreign_key_columns k on k.constraint_object_id=f.object_id join sys.tables t on t.object_id=f.parent_object_id join sys.tables rt on rt.object_id=f.referenced_object_id order by source_schema,source_table,constraint_name,position`;
  else sql=`select k.table_schema as source_schema,k.table_name as source_table,k.constraint_name,k.column_name as source_column,k.referenced_table_schema as target_schema,k.referenced_table_name as target_table,k.referenced_column_name as target_column,k.ordinal_position as position,r.delete_rule,r.update_rule from information_schema.key_column_usage k join information_schema.referential_constraints r on r.constraint_schema=k.constraint_schema and r.constraint_name=k.constraint_name and r.table_name=k.table_name where k.table_schema=${literal(d.database)} and k.referenced_table_name is not null order by k.table_schema,k.table_name,k.constraint_name,k.ordinal_position`;
  const groups=new Map(),rules={a:'NO ACTION',r:'RESTRICT',c:'CASCADE',n:'SET NULL',d:'SET DEFAULT'};
  for(const raw of await c.query(sql)){const r=Object.fromEntries(Object.entries(raw).map(([k,v])=>[k.toLowerCase(),v])),key=JSON.stringify([r.source_schema,r.source_table,r.constraint_name]);let fk=groups.get(key);if(!fk){fk={sourceSchema:r.source_schema,sourceTable:r.source_table,name:r.constraint_name,targetSchema:r.target_schema,targetTable:r.target_table,columns:[],referencedColumns:[],onDelete:rules[r.delete_rule]||String(r.delete_rule).replaceAll('_',' '),onUpdate:rules[r.update_rule]||String(r.update_rule).replaceAll('_',' ')};groups.set(key,fk);}fk.columns.push(r.source_column);fk.referencedColumns.push(r.target_column);}
  return [...groups.values()];
});}
function dependencyOrder(mapped,keys,side){
  const result=[],visiting=new Set(),done=new Set(),key=t=>JSON.stringify([t[side+'Schema'],t[side+'Table']]);
  function visit(t){const id=key(t);if(done.has(id))return;if(visiting.has(id))throw Error('Cyclic foreign keys need a database-specific migration plan before replacing rows');visiting.add(id);for(const fk of keys.filter(f=>f.sourceSchema===t[side+'Schema']&&f.sourceTable===t[side+'Table'])){const parent=mapped.find(m=>m[side+'Schema']===fk.targetSchema&&m[side+'Table']===fk.targetTable);if(parent&&key(parent)!==id)visit(parent);}visiting.delete(id);done.add(id);result.push(t);}
  mapped.forEach(visit);return result;
}
function migrationDependencies(prepared,mapped,preserve){
  for(const fk of prepared.targetForeignKeys){const parent=mapped.find(t=>t.targetSchema===fk.targetSchema&&t.targetTable===fk.targetTable),child=mapped.find(t=>t.targetSchema===fk.sourceSchema&&t.targetTable===fk.sourceTable);if(parent&&!child)throw Error('An unselected destination table references a selected table. Include the dependent table or choose an empty destination');}
  const keys=preserve?prepared.foreignKeys.filter(f=>mapped.some(t=>t.sourceSchema===f.sourceSchema&&t.sourceTable===f.sourceTable)):[];
  for(const fk of keys)if(!mapped.some(t=>t.sourceSchema===fk.targetSchema&&t.sourceTable===fk.targetTable))throw Error('Include every source table referenced by the selected foreign keys');
  return{keys,insertOrder:dependencyOrder(mapped,keys,'source'),deleteOrder:dependencyOrder(mapped,prepared.targetForeignKeys,'target').reverse()};
}
async function counts(d,driver,mapped,side){return session(d,driver,async c=>{
  const result={};for(const t of mapped){const name=object(d,t[side+'Schema'],t[side+'Table']),sql=d.provider==='sqlserver'?`select convert(varchar(30),count_big(*)) as count from ${name}`:`select cast(count(*) as ${d.provider==='postgresql'?'text':'char'}) as count from ${name}`;result[t.sourceObject]=String((await c.query(sql))[0].count);}return result;
});}
async function preview(source,target,driver){
  const physical=d=>[d.provider==='mariadb'?'mysql':d.provider,['localhost','::1','[::1]'].includes(d.host)?'127.0.0.1':d.host.toLowerCase(),d.port,d.database].join(':');if(physical(source)===physical(target))throw Error('Choose a different destination database');
  const [src,dst]=await Promise.all([tables(source,driver),tables(target,driver)]);if(!src.length)throw Error('The source database has no tables');
  const mapped=src.filter(t=>!t.table.startsWith('_manager_migration_')).map(t=>{const name=t.schema===schema(source)?t.table:t.schema+'_'+t.table;quote(target.provider,name);return{sourceSchema:t.schema,sourceTable:t.table,sourceObject:t.schema+'.'+t.table,targetSchema:schema(target),targetTable:name,targetObject:schema(target)+'.'+name,targetExists:dst.some(d=>d.schema===schema(target)&&d.table.toLowerCase()===name.toLowerCase())};});
  if(mapped.length>500)throw Error('Migrate at most 500 tables at a time');
  if(!mapped.length||new Set(mapped.map(t=>t.targetObject.toLowerCase())).size!==mapped.length)throw Error('Source tables have conflicting destination names');
  const shapes=await Promise.all([session(source,driver,async c=>Promise.all(mapped.map(t=>columns(c,source,t.sourceSchema,t.sourceTable)))),session(target,driver,async c=>Promise.all(mapped.map(t=>columns(c,target,t.targetSchema,t.targetTable))))]);
  const [sourceKeys,targetKeys]=await Promise.all([foreignKeys(source,driver),foreignKeys(target,driver)]),sourceForeignKeys=sourceKeys.filter(r=>mapped.some(t=>t.sourceSchema===r.sourceSchema&&t.sourceTable===r.sourceTable)),targetForeignKeys=targetKeys.filter(r=>!r.sourceTable.startsWith('_manager_migration_'));
  return{tables:mapped,foreignKeys:sourceForeignKeys,targetForeignKeys,existingTargetTables:mapped.filter(t=>t.targetExists).length,shapeHash:hash({mapped,shapes,foreignKeys:sourceForeignKeys,targetForeignKeys})};
}
function slingConnection(d){const common={host:d.host,port:d.port,user:d.username,password:d.password,database:d.database};return JSON.stringify(d.provider==='postgresql'?{type:'postgres',...common,sslmode:d.tls?'verify-full':'disable'}:d.provider==='sqlserver'?{type:'sqlserver',...common,encrypt:d.tls?'true':'false',trust_server_certificate:d.tls?'false':'true'}:{type:'mysql',...common,tls:d.tls?'true':'false'});}
async function promote(target,driver,mapped,marker,expected,checkCancelled,dependencies={keys:[],insertOrder:mapped,deleteOrder:mapped}){
  return session(target,driver,async c=>{
    const mysql=['mysql','mariadb'].includes(target.provider),q=v=>quote(target.provider,v),name=t=>object(target,t.targetSchema,t.targetTable),stage=t=>object(target,t.targetSchema,t.stage);
    const definitions=[];
    for(const t of mapped){
      const dst=await columns(c,target,t.targetSchema,t.targetTable),src=await columns(c,target,t.targetSchema,t.stage);
      if(!src.length)throw Error('A staged table is missing');if(!!dst.length!==t.targetExists)throw Error('Destination tables changed during the copy');
      if(dst.length){
        const writable=dst.filter(r=>r.is_generated!=='ALWAYS'&&r.is_computed!==1&&!/GENERATED/i.test(r.extra||'')&&r.data_type!=='timestamp'&&r.data_type!=='rowversion');
        // PostgreSQL/MySQL timestamp is ordinary writable data; only SQL Server
        // timestamp/rowversion is generated by the engine.
        const selected=target.provider==='sqlserver'?writable:dst.filter(r=>r.is_generated!=='ALWAYS'&&!/GENERATED/i.test(r.extra||''));
        if(!selected.length||selected.some(r=>!src.some(s=>s.column_name===r.column_name))||src.some(s=>!dst.some(r=>r.column_name===s.column_name)))throw Error('The destination columns do not match the copied table; choose an empty destination or reconcile its schema first');
        definitions.push({t,columns:selected.map(r=>q(r.column_name)).join(','),identity:selected.some(r=>r.is_identity===1||r.is_identity==='YES')});
      }else definitions.push({t});
    }
    // MySQL DDL commits implicitly. Only create previously absent destination
    // tables here; existing rows are changed together in the transaction below.
    const createKeys=async()=>{let index=0;for(const fk of dependencies.keys){const child=mapped.find(t=>t.sourceSchema===fk.sourceSchema&&t.sourceTable===fk.sourceTable),parent=mapped.find(t=>t.sourceSchema===fk.targetSchema&&t.sourceTable===fk.targetTable);if(child.targetExists)continue;const rule=value=>{if(!['NO ACTION','RESTRICT','CASCADE','SET NULL','SET DEFAULT'].includes(value))throw Error('Unsupported foreign key action');return target.provider==='sqlserver'&&value==='RESTRICT'?'NO ACTION':value;};await c.query(`alter table ${name(child)} add constraint ${q(marker.replace('_receipt','_fk')+'_'+index++)} foreign key (${fk.columns.map(q).join(',')}) references ${name(parent)} (${fk.referencedColumns.map(q).join(',')}) on delete ${rule(fk.onDelete)} on update ${rule(fk.onUpdate)}`);}};
    if(mysql){
      for(const {t}of definitions)if(!t.targetExists){checkCancelled();await c.query(`create table ${name(t)} like ${stage(t)}`);}
      await c.query(`create table ${object(target,schema(target),marker)} (receipt varchar(64) not null) engine=InnoDB`);
      const engines=await c.query(`select table_name,engine from information_schema.tables where table_schema=${literal(schema(target))} and table_name in (${mapped.map(t=>literal(t.targetTable)).join(',')})`);
      if(engines.some(t=>(t.engine||t.ENGINE)!=='InnoDB'))throw Error('Target tables must use InnoDB so a failed copy can roll back');
      await createKeys();
    }
    await c.begin();
    try{
      if(target.provider==='postgresql')await c.query("set local lock_timeout='5s'");
      if(target.provider==='sqlserver')await c.query('set xact_abort on; set lock_timeout 5000');
      for(const t of dependencies.deleteOrder)if(t.targetExists){checkCancelled();await c.query(`delete from ${name(t)}`);}
      for(const ordered of dependencies.insertOrder){checkCancelled();const def=definitions.find(d=>d.t===ordered),{t}=def;
        if(!t.targetExists&&!mysql){
          if(target.provider==='postgresql')await c.query(`alter table ${stage(t)} rename to ${q(t.targetTable)}`);
          else await c.query(`exec sp_rename ${literal(stage(t))},${literal(t.targetTable)}`);
        }else{
          const fields=def.columns||(await columns(c,target,t.targetSchema,t.stage)).filter(r=>!/GENERATED/i.test(r.extra||'')).map(r=>q(r.column_name)).join(',');
          if(target.provider==='sqlserver'&&def.identity)await c.query(`set identity_insert ${name(t)} on`);
          await c.query(`insert into ${name(t)} (${fields}) ${target.provider==='postgresql'&&def.identity?'overriding system value ':''}select ${fields} from ${stage(t)}`);
          if(target.provider==='sqlserver'&&def.identity)await c.query(`set identity_insert ${name(t)} off`);
        }
        const result=await c.query(`select ${target.provider==='sqlserver'?'convert(varchar(30),count_big(*))':`cast(count(*) as ${target.provider==='postgresql'?'text':'char'})`} as count from ${name(t)}`);
        if(String(result[0].count)!==expected[t.sourceObject])throw Error('The destination did not retain the verified row count');
        if(target.provider==='postgresql'){
          for(const column of await columns(c,target,t.targetSchema,t.targetTable)){
            const sequence=(await c.query(`select pg_get_serial_sequence(${literal(name(t))},${literal(column.column_name)}) as sequence`))[0].sequence;
            if(sequence){const negative=Number((await c.query(`select seqincrement from pg_sequence where seqrelid=${literal(sequence)}::regclass`))[0].seqincrement)<0;await c.query(`select setval(${literal(sequence)},${negative?'least':'greatest'}((select last_value from ${sequence}),(select ${negative?'min':'max'}(${q(column.column_name)}) from ${name(t)})),true)`);}
          }
        }
      }
      if(!mysql)await createKeys();
      // This receipt commits with every target data change. After a connection
      // loss the agent can distinguish committed data from an interrupted copy.
      if(!mysql)await c.query(`create table ${object(target,schema(target),marker)} (receipt varchar(64) not null)`);
      await c.query(`insert into ${object(target,schema(target),marker)} values (${literal(hash(mapped))})`);
      checkCancelled();await c.commit();
    }catch(error){await c.rollback().catch(()=>{});throw error;}
  });
}
async function receipt(target,driver,mapped,marker){
  if(!(await tables(target,driver)).some(t=>t.schema===schema(target)&&t.table===marker))return false;
  return session(target,driver,async c=>{const rows=await c.query(`select receipt from ${object(target,schema(target),marker)}`);if(!rows.length)return false;if(rows.length!==1||rows[0].receipt!==hash(mapped))throw Error('The migration receipt identity changed');return true;});
}
module.exports={providers,quote,object,schema,hash,session,tables,columns,foreignKeys,dependencyOrder,migrationDependencies,counts,preview,slingConnection,promote,receipt};
