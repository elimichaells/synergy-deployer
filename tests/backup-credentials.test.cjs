const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const load=require('./server-module.cjs');
const policy=require('../lib/backup-policy.ts');
const target={id:'service',database_name:'fixture_db',username:'restricted_app',password_ciphertext:'app-cipher',connection_username:'backup_admin',connection_password_ciphertext:'admin-cipher',managed:true,provider:'postgresql',host:'localhost',port:5433,tls_enabled:true};

test('backup account selection is explicit and never silently falls back to administrator access',()=>{
 assert.deepEqual(policy.selectBackupCredential(target,'application'),{username:'restricted_app',ciphertext:'app-cipher'});
 assert.deepEqual(policy.selectBackupCredential(target,'connection'),{username:'backup_admin',ciphertext:'admin-cipher'});
 assert.throws(()=>policy.selectBackupCredential({...target,managed:false},'connection'),/managed/);
 assert.throws(()=>policy.selectBackupCredential({...target,password_ciphertext:null},'application'),/unavailable/);
 assert.throws(()=>policy.backupCredentialSource('auto'),/Select/);
});

test('backup diagnostics keep permission errors before long SQL and redact secrets',()=>{
 const output='pg_dump: error: ERROR: permission denied for table schema_migrations\npg_dump: detail: Query was: LOCK TABLE '+ 'table, '.repeat(1000);
 assert.match(policy.backupFailure(output),/permission denied for table schema_migrations/);
 assert.ok(policy.backupFailure(output).length<1100);
 assert.doesNotMatch(policy.backupFailure('error: password=private postgres://u:pass@server/db topsecret',['topsecret']),/private|u:pass|topsecret/);
});

function fixture(t,source='connection') {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'manager-backup-test-'));t.after(()=>{assert.ok(root.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true})});
 const calls=[];let finished=false;
 const schedule={id:'schedule',service_id:'service',enabled:false,retention_count:30,credential_source:source};
 const mocks={
  '@/lib/api':require('../lib/api.ts'), '@/lib/backup-policy':policy,
  '@/lib/backup-schedules':{getNextBackupRun:()=>new Date(),isBackupFrequency:x=>x==='daily',validateBackupTime:()=>true},
  '@/lib/secret-crypto':{decryptSecret:value=>value==='admin-cipher'?'admin-secret':'app-secret'},
  '@/lib/settings':{getSetting:async key=>key==='BACKUP_DIR'?root:root},
  '@/lib/cron-jobs':{validateTimezone:()=>true}, '@/lib/notify':{sendNotification:async()=>assert.fail('No notification expected')},
  '@/lib/db':{query:async(sql,values)=>{calls.push({sql,values});if(sql.startsWith('select *'))return {rows:[schedule]};if(sql.includes("set last_status='running'"))return {rows:[schedule]};if(sql.includes('select pds.id'))return {rows:[target]};if(sql.includes("set last_status='success'"))finished=true;return {rows:[]}}},
  child_process:{spawn:(exe,args,options)=>{calls.push({exe,args,options});const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};process.nextTick(()=>{fs.writeFileSync(args[args.indexOf('-f')+1],'PGDMPfixture');child.emit('close',0)});return child}},
 };
 return {api:load('lib/data-service-backups.ts',mocks),calls,finished:()=>finished};
}

test('scheduled dump uses only the selected credential, bounded locks and TLS; records real success',async t=>{
 const f=fixture(t);assert.equal((await f.api.executeDataServiceBackup('schedule','manual')).started,true);
 for(let i=0;i<100&&!f.finished();i++)await new Promise(r=>setImmediate(r));
 assert.equal(f.finished(),true);const command=f.calls.find(x=>x.exe);assert.ok(command.args.includes('--lock-wait-timeout=5s'));
 assert.equal(command.args[command.args.indexOf('-U')+1],'backup_admin');assert.equal(command.options.env.PGPASSWORD,'admin-secret');assert.equal(command.options.env.PGSSLMODE,'require');assert.equal(command.options.env.PGCONNECT_TIMEOUT,'10');
 assert.ok(!f.calls.some(x=>x.sql&&/grant|alter role|update project_data_services/i.test(x.sql)));
});

test('existing schedules retain their credential source when older clients edit the schedule',async()=>{
 const calls=[];
 const api=load('lib/data-service-backups.ts',{
  '@/lib/api':require('../lib/api.ts'),'@/lib/backup-policy':policy,
  '@/lib/backup-schedules':{getNextBackupRun:()=>new Date(),isBackupFrequency:()=>true,validateBackupTime:()=>true},
  '@/lib/secret-crypto':{},'@/lib/settings':{},'@/lib/cron-jobs':{validateTimezone:()=>true},'@/lib/notify':{},
  '@/lib/db':{query:async(sql,values)=>{calls.push({sql,values});return {rows:sql.includes('select dc.provider')?[{provider:'postgresql',managed:true,credential_ready:true}]:[{}]}}},
 });
 await api.configureDataServiceBackup('service',{frequency:'daily'});
 const upsert=calls.find(x=>x.sql.includes('insert into data_service_backup_schedules'));assert.equal(upsert.values[11],null);assert.match(upsert.sql,/credential_source=coalesce\(\$12::text,data_service_backup_schedules.credential_source\)/);
});
