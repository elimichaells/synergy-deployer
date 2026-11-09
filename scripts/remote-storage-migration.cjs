'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),engine=require('./relational-migration.cjs');
const ID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const check=input=>{if(!ID.test(input.operationId)||!ID.test(input.serviceId)||!ID.test(input.targetServiceId))throw Error('Invalid migration identity');};
async function plan(root,input,h,driver){
  check(input);const paths=await h.readJson(path.join(root,'tool-paths.json'),{});
  if(!paths.sling)throw Error('Install or register Sling in Runtimes & tools on this server first');
  await h.run(paths.sling,['--version'],{timeout:15000,env:{...h.baseEnv(),AWS_EC2_METADATA_DISABLED:'true'}});
  const prepared=await engine.preview(input.connection,input.target,driver);
  return{...prepared,source:input.source,target:input.destination,sling:paths.sling,review:input.operationId,agentReview:engine.hash({prepared,connection:input.connection,target:input.target,sling:paths.sling})};
}
async function outcome(tx,driver){
  if(!await engine.receipt(tx.target,driver,tx.tables,tx.marker))return{ok:true,operationId:tx.operationId,status:'interrupted',validation:null,log:'The transfer did not commit its destination receipt. Original source data is unchanged. Staged copies and any new empty destination tables were preserved for review.'};
  const counts=await engine.counts(tx.target,driver,tx.tables,'target'),validation=tx.tables.map(t=>({table:t.sourceObject,target:t.targetObject,sourceRows:tx.expected[t.sourceObject],targetRows:counts[t.sourceObject],match:tx.expected[t.sourceObject]===counts[t.sourceObject]}));
  if(validation.some(t=>!t.match))throw Error('Committed destination rows changed before verification. Review this migration before activation');
  return{ok:true,operationId:tx.operationId,status:'succeeded',validation,log:'Copied tables through a private staging area and verified source and destination row counts. Destination changes committed together. Source data and application settings remain unchanged.'};
}
async function execute(root,input,h,driver){
  check(input);
  if(input.operation==='migration-preview')return{ok:true,preview:await plan(root,input,h,driver)};
  const file=await h.contained(root,'data-migrations',input.operationId,'journal.json');let tx=await h.readJson(file);
  if(tx){
    if(engine.hash(tx.connection)!==engine.hash(input.connection)||engine.hash(tx.target)!==engine.hash(input.target))throw Error('Migration journal belongs to another database');
    if(tx.result)return tx.result;
    const result=await outcome(tx,driver);await h.atomicJson(file,{...tx,result});return result;
  }
  if(input.operation==='migration-reconcile')return{ok:true,operationId:input.operationId,status:'interrupted',validation:null,log:'The agent did not start this migration. Source and destination data are unchanged.'};
  if(input.operation!=='migration-run')throw Error('Unknown migration operation');
  const prepared=await plan(root,input,h,driver);if(prepared.agentReview!==input.agentReview)throw Error('The database tables or runtime changed. Review the migration again');
  const selected=prepared.tables.filter(t=>input.tables.includes(t.sourceObject));if(!selected.length||selected.length!==new Set(input.tables).size)throw Error('The selected source tables changed');
  if(selected.some(t=>t.targetExists)&&input.replaceTarget!==true)throw Error('Confirm replacement of existing target rows');
  if(input.writesPaused!==true||input.backupConfirmed!==true)throw Error('Pause database writers and confirm a backup before copying');
  const prefix='_manager_migration_'+input.operationId.replaceAll('-','').slice(0,18),tables=selected.map((t,i)=>({...t,stage:prefix+'_'+i})),marker=prefix+'_receipt',checkCancelled=()=>{if(h.signal?.aborted)throw Error('Migration cancelled');};
  const dependencies=engine.migrationDependencies(prepared,tables,input.preserveSchema===true);
  const existing=await engine.tables(input.target,driver);if(existing.some(t=>tables.some(s=>s.targetSchema===t.schema&&s.stage===t.table)||t.table===marker))throw Error('This migration staging area already exists');
  const expected=await engine.counts(input.connection,driver,tables,'source');checkCancelled();
  tx={...input,tables,marker,expected,phase:'copying'};await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await h.atomicJson(file,tx);
  try{
    // Sling parses its own quoted table syntax before generating provider SQL.
    // SQL Server brackets would become literal characters in the object name.
    const slingObject=(provider,schema,table)=>{const q=['mysql','mariadb'].includes(provider)?'`':'"';return[schema,table].map(value=>{if(value.includes(q))throw Error('This table name contains a quote delimiter unsupported by the migration runtime');return q+value+q;}).join('.');};
    const config=path.join(path.dirname(file),'replication.json'),streams=Object.fromEntries(tables.map(t=>[slingObject(input.connection.provider,t.sourceSchema,t.sourceTable),{object:slingObject(input.target.provider,t.targetSchema,t.stage)}]));
    await h.atomicJson(config,{source:'MANAGER_MIGRATION_SOURCE',target:'MANAGER_MIGRATION_TARGET',defaults:{mode:'full-refresh',target_options:{column_casing:'source'}},streams});
    // Foreign keys are recreated against final table names, never staging
    // copies. This also avoids Sling's quoted-name FK sorter ambiguity.
    await h.run(prepared.sling,['run','-r',config],{cwd:path.dirname(file),timeout:1800000,signal:h.signal,log:h.log,secrets:[input.connection.password,input.target.password],env:{...h.baseEnv(),MANAGER_MIGRATION_SOURCE:engine.slingConnection(input.connection),MANAGER_MIGRATION_TARGET:engine.slingConnection(input.target),SLING_SCHEMA_MIGRATION:input.preserveSchema?'primary_key,indexes,auto_increment,nullable,default_value,description':'',SLING_SEND_TELEMETRY:'false',AWS_EC2_METADATA_DISABLED:'true'}});
    checkCancelled();const stageMap=tables.map(t=>({...t,targetTable:t.stage})),[after,copied]=await Promise.all([engine.counts(input.connection,driver,tables,'source'),engine.counts(input.target,driver,stageMap,'target')]);
    if(tables.some(t=>expected[t.sourceObject]!==after[t.sourceObject]||expected[t.sourceObject]!==copied[t.sourceObject]))throw Error('Source or copied row counts changed; destination rows were not replaced');
    const current=await engine.preview(input.connection,input.target,driver);
    // Our staging and receipt objects are excluded from previews.
    if(current.shapeHash!==prepared.shapeHash)throw Error('Source or destination schema changed during the copy');
    tx.phase='promoting';await h.atomicJson(file,tx);
    await engine.promote(input.target,driver,tables,marker,expected,checkCancelled,dependencies);
    const result=await outcome(tx,driver);await h.atomicJson(file,{...tx,phase:'accepted',result});return result;
  }catch(error){
    // Reconcile a possibly successful COMMIT rather than treating a dropped
    // network response or cancellation as proof that no data changed.
    const result=await outcome(tx,driver);
    if(result.status!=='succeeded'){result.status=h.signal?.aborted?'cancelled':'failed';result.error=h.redact(String(error.message||'Migration failed'),[input.connection.password,input.target.password]).slice(0,1500);result.log+=' '+result.error;}
    await h.atomicJson(file,{...tx,phase:'finished',result});return result;
  }
}
module.exports={execute,plan};
