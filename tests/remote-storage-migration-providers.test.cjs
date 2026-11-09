'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{randomUUID}=require('node:crypto');
const engine=require('../scripts/relational-migration.cjs');
test('offline agent migrates real PostgreSQL, MySQL, MariaDB and SQL Server through protected staging',{skip:process.env.MANAGER_STORAGE_PROVIDER_LAB!=='1'||!process.env.TEST_SLING,timeout:600000},async t=>{
  assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert.equal(process.platform,'linux');
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'manager-migrate-providers-'));t.after(async()=>{assert.equal(path.dirname(root),parent);await fs.rm(root,{recursive:true,force:true});});
  const file=path.join(root,'agent.cjs');await fs.writeFile(file,await require('../scripts/agent-bundle.cjs').agentBundle());const agent=require(file);
  const driver=async name=>require(name),archive=await require('../scripts/agent-postgres-runtime.cjs').packagePostgresRuntime(process.cwd(),['mysql2','mssql']);
  await agent.atomicJson(path.join(root,'tool-paths.json'),{sling:process.env.TEST_SLING});
  const engines=[['postgresql',15436,'fixture_admin','postgres'],['mysql',33161,'root','mysql'],['mariadb',33162,'root','mysql'],['sqlserver',11433,'sa','master']].map(([provider,port,username,database])=>({provider,host:'127.0.0.1',port,username,database,password:'Fixture-Storage-Password-2026',tls:false}));
  for(const d of engines){let ready=false,last;for(let i=0;i<20;i++){try{await engine.session(d,driver,c=>c.query('select 1'));ready=true;break;}catch(error){last=error;await new Promise(r=>setTimeout(r,1500));}}if(!ready)throw last;}
  for(const [sourceIndex,targetIndex]of [[0,1],[1,2],[2,3],[3,0],[0,3],[3,1]])await t.test(engines[sourceIndex].provider+' to '+engines[targetIndex].provider,async()=>{
    const suffix=randomUUID().replaceAll('-','').slice(0,18),source={...engines[sourceIndex],database:'migration_src_'+suffix},target={...engines[targetIndex],database:'migration_dst_'+suffix},q=(d,name)=>engine.quote(d.provider,name),table=(d,name)=>engine.object(d,engine.schema(d),name);
    for(const [d,admin]of [[source,engines[sourceIndex]],[target,engines[targetIndex]]])await engine.session(admin,driver,c=>c.query('create database '+q(d,d.database)));
    try{
      await engine.session(source,driver,async c=>{await c.query(`create table ${table(source,'books')}(id bigint primary key,title varchar(100))`);await c.query(`insert into ${table(source,'books')} values(9007199254740993,'Original source')`);await c.query(`create table ${table(source,'notes')}(id int primary key,book_id bigint references ${table(source,'books')}(id),body varchar(100))`);await c.query(`insert into ${table(source,'notes')} values(1,9007199254740993,'Preserved note')`);});
      await engine.session(target,driver,async c=>{await c.query(`create table ${table(target,'books')}(id bigint primary key,title varchar(100),constraint forbid_fixture check(title='Keep target'))`);await c.query(`insert into ${table(target,'books')} values(5,'Keep target')`);});
      const base={action:'storage',serviceId:randomUUID(),targetServiceId:randomUUID(),connection:source,target,source:{name:'Source'},destination:{name:'Target'},driverArchive:archive},run=resource=>agent.infrastructureJob(root,{payload:{action:'resource',resource:{...base,...resource},expiresAt:Date.now()+60000}},{},()=>{});
      let preview=await run({operation:'migration-preview',operationId:randomUUID()}),input={operation:'migration-run',operationId:preview.preview.review,agentReview:preview.preview.agentReview,tables:preview.preview.tables.map(t=>t.sourceObject),replaceTarget:true,preserveSchema:true,backupConfirmed:true,writesPaused:true};
      const failed=await run(input);assert.equal(failed.status,'failed');assert.equal((await engine.session(target,driver,c=>c.query(`select title from ${table(target,'books')}`)))[0].title,'Keep target');
      await engine.session(target,driver,c=>c.query(`alter table ${table(target,'books')} drop ${target.provider==='mysql'?'check':'constraint'} forbid_fixture`));
      preview=await run({operation:'migration-preview',operationId:randomUUID()});input={...input,operationId:preview.preview.review,agentReview:preview.preview.agentReview};const result=await run(input);assert.equal(result.status,'succeeded',result.error);assert.ok(result.validation.every(v=>v.match));const keys=await engine.foreignKeys(target,driver);assert.ok(keys.some(k=>k.sourceTable==='notes'&&k.targetTable==='books'),'foreign key targets the final table');await assert.rejects(engine.session(target,driver,c=>c.query(`insert into ${table(target,'notes')} values(2,123,'Invalid reference')`)));
      for(const d of [source,target]){const cast=d.provider==='sqlserver'?'convert(varchar(30),id)':`cast(id as ${d.provider==='postgresql'?'text':'char'})`;const rows=await engine.session(d,driver,c=>c.query(`select ${cast} as id,title from ${table(d,'books')}`));assert.equal(rows[0].id,'9007199254740993');assert.equal(rows[0].title,'Original source');}
    }finally{
      for(const [d,admin]of [[source,engines[sourceIndex]],[target,engines[targetIndex]]])await engine.session(admin,driver,c=>c.query('drop database '+q(d,d.database)));
    }
  });
});
