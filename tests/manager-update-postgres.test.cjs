const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const W=require('../scripts/manager-update-worker.cjs');
test('real PostgreSQL updater backup restores its data and active jobs block installation',{skip:!process.env.MANAGER_UPDATE_TEST_DATABASE_URL||!process.env.MANAGER_UPDATE_TEST_PG_BIN},async t=>{
  const url=new URL(process.env.MANAGER_UPDATE_TEST_DATABASE_URL);
  assert.ok(['127.0.0.1','localhost'].includes(url.hostname));assert.match(url.pathname,/^\/manager_remote_test_/);
  const {Client}=require('pg'),client=new Client({connectionString:url.href});await client.connect();
  const cleanup=[];t.after(async()=>{try{for(const work of cleanup)await work()}finally{await client.end()}});
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'manager-update-pg-test-'));
  t.after(()=>{assert.ok(root.startsWith(path.join(os.tmpdir(),'manager-update-pg-test-')));fs.rmSync(root,{recursive:true,force:true})});
  const c={managerRoot:path.join(root,'manager'),stateRoot:path.join(root,'recovery'),pm2Home:path.join(root,'pm2'),pgDump:path.join(process.env.MANAGER_UPDATE_TEST_PG_BIN,process.platform==='win32'?'pg_dump.exe':'pg_dump')};
  fs.mkdirSync(c.managerRoot,{recursive:true});fs.mkdirSync(c.stateRoot,{recursive:true});
  fs.writeFileSync(path.join(c.managerRoot,'.env.local'),'DATABASE_URL='+url.href+'\nTEST_SECRET=retained\n');
  const value=crypto.randomUUID();await client.query('create table if not exists updater_backup_fixture(value text)');await client.query('insert into updater_backup_fixture values($1)',[value]);
  cleanup.push(()=>client.query('delete from updater_backup_fixture where value=$1',[value]));
  const dir=path.join(c.stateRoot,'job');fs.mkdirSync(dir);
  const state={id:crypto.randomUUID(),events:[]};await W.backup(c,dir,state);assert.equal(state.backupCreated,true);
  assert.match(fs.readFileSync(path.join(dir,'backup/.env.local'),'utf8'),/TEST_SECRET=retained/);
  const restored='manager_remote_test_restore_'+crypto.randomBytes(8).toString('hex');
  await client.query('create database '+restored);
  cleanup.push(()=>client.query('drop database '+restored+' with (force)'));
  const pgEnv={...process.env,PGHOST:url.hostname,PGPORT:url.port,PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password)};
  await W.command(path.join(process.env.MANAGER_UPDATE_TEST_PG_BIN,process.platform==='win32'?'pg_restore.exe':'pg_restore'),['--no-owner','--no-acl','--dbname',restored,path.join(dir,'backup/manager.pgdump')],pgEnv);
  const restoredUrl=new URL(url);restoredUrl.pathname='/'+restored;const restoredClient=new Client({connectionString:restoredUrl.href});await restoredClient.connect();
  try{assert.equal((await restoredClient.query('select value from updater_backup_fixture where value=$1',[value])).rowCount,1)}finally{await restoredClient.end()}
  if(!(await client.query("select to_regclass('deployments') as name")).rows[0].name) {
    await client.query("create type updater_test_status as enum ('queued','running','success'); create table deployments(id uuid primary key,status updater_test_status)");
    cleanup.push(()=>client.query('drop table deployments; drop type updater_test_status'));
    await client.query("insert into deployments values($1,'queued')",[value]);
    await assert.rejects(W.assertIdle(c),/active deployments/);
    await client.query('delete from deployments where id=$1',[value]);
    await W.assertIdle(c);
  }
  fs.mkdirSync(path.join(c.stateRoot,'operations'));fs.writeFileSync(path.join(c.stateRoot,'operations/active.json'),'{}');
  await assert.rejects(W.assertIdle(c),/active|running|queued/);
});
