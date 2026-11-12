'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{createHash,randomUUID}=require('node:crypto');
const upgrade=require('../scripts/service-upgrade.cjs'),policy=require('../scripts/service-upgrade-policy.cjs');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-upgrade-test-'));t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());assert.match(path.basename(root),/^manager-upgrade-test-/);await fs.rm(root,{recursive:true,force:true})});return root;}
test('database upgrades stay within the installed series and reject downgrade',()=>{
  assert.equal(policy.validate('composer','PHP version 8.3.6\nComposer version 2.11.1','2.11.2','linux').currentVersion,'2.11.1');
  assert.equal(policy.version('C:\\mysql-8.4.11-winx64\\bin\\mysql.exe Ver 8.4.13 for Win64 on x86_64 (MySQL Community Server - GPL)'),'8.4.13');
  for(const [service,current,next]of [['postgresql','18.5','18.6'],['mysql','8.4.12','8.4.13'],['mariadb','11.4.12','11.4.13'],['mongodb','8.0.33','8.0.34']])assert.equal(policy.validate(service,current,next,'win32').version,next);
  assert.throws(()=>policy.validate('mysql','8.4.13','9.0.0','win32'),/release series/);assert.throws(()=>policy.validate('postgresql','18.6','18.5','win32'),/newer/);assert.throws(()=>policy.validate('redis','8.2.11','8.2.12','win32'),/maintenance/);
});

test('Composer verification ignores the PHP version emitted before its version line',async()=>{
  const original=upgrade.run;upgrade.run=async()=> 'PHP version 8.3.6 (/usr/bin/php8.3)\nComposer version 2.11.2 2026-10-20\n';
  try{assert.equal(await require('../scripts/service-upgrade-runner.cjs').binaryVersion('composer','fixture.phar',{php:'fixture-php'}),'2.11.2')}finally{upgrade.run=original}
});
test('binary update verifies a cold backup before replacing files and preserves unrelated configuration',async t=>{
  const root=await fixture(t),target=path.join(root,'update'),exe=path.join(root,'engine'),candidate=path.join(root,'new-engine'),config=path.join(root,'site.conf'),data=path.join(root,'database');await fs.writeFile(exe,'old');await fs.writeFile(candidate,'new');await fs.writeFile(config,'existing site');await fs.writeFile(data,'existing row');const events=[];
  await upgrade.replaceFiles(target,[{source:candidate,destination:exe}],async()=>{events.push('verify');assert.equal(await fs.readFile(exe,'utf8'),'new')},{stop:async()=>events.push('stop'),start:async()=>events.push('start'),backup:async folder=>{events.push('backup');assert.equal(await fs.readFile(exe,'utf8'),'old');await fs.copyFile(data,path.join(folder,'data-before'))}});
  assert.deepEqual(events,['stop','backup','start','verify']);assert.equal(await fs.readFile(path.join(target,'backup','0'),'utf8'),'old');assert.equal(await fs.readFile(config,'utf8'),'existing site');assert.equal(await fs.readFile(data,'utf8'),'existing row');
});
test('failed readiness restores a stateless service and leaves peer files unchanged',async t=>{
  const root=await fixture(t),exe=path.join(root,'engine'),candidate=path.join(root,'candidate');await fs.writeFile(exe,'old');await fs.writeFile(candidate,'new');let starts=0;await assert.rejects(upgrade.replaceFiles(path.join(root,'upgrade'),[{source:candidate,destination:exe}],async()=>{throw Error('fixture readiness failed')},{stop:async()=>{},start:async()=>starts++}),/readiness failed/);assert.equal(starts,2);assert.equal(await fs.readFile(exe,'utf8'),'old');
});
test('database readiness failure preserves changed data and requires reviewed recovery instead of a blind downgrade',async t=>{
  const root=await fixture(t),exe=path.join(root,'engine'),candidate=path.join(root,'candidate'),data=path.join(root,'data'),target=path.join(root,'upgrade');await fs.writeFile(exe,'old');await fs.writeFile(candidate,'new');await fs.writeFile(data,'before');await assert.rejects(upgrade.replaceFiles(target,[{source:candidate,destination:exe}],async()=>{await fs.writeFile(data,'new database format');throw Error('fixture')},{database:true,stop:async()=>{},start:async()=>{}}),/reviewed recovery/);assert.equal(await fs.readFile(data,'utf8'),'new database format');assert.equal(JSON.parse(await fs.readFile(path.join(target,'upgrade.json'))).phase,'needs_review');
});
test('failed cold backup restarts the old service before replacing any binaries',async t=>{
  const root=await fixture(t),exe=path.join(root,'engine'),candidate=path.join(root,'candidate');await fs.writeFile(exe,'old');await fs.writeFile(candidate,'new');let starts=0;await assert.rejects(upgrade.replaceFiles(path.join(root,'upgrade'),[{source:candidate,destination:exe}],async()=>{}, {database:true,stop:async()=>{},start:async()=>starts++,backup:async()=>{throw Error('backup failed')}}),/backup failed/);assert.equal(starts,1);assert.equal(await fs.readFile(exe,'utf8'),'old');
});

test('an unconfirmed service stop keeps the operation locked for recovery',async t=>{
  const root=await fixture(t),exe=path.join(root,'engine'),source=path.join(root,'candidate'),target=path.join(root,'update');await fs.writeFile(exe,'old');await fs.writeFile(source,'new');let starts=0;
  await assert.rejects(upgrade.replaceFiles(target,[{source,destination:exe}],async()=>{}, {stop:async()=>{throw Error('stop timeout')},start:async()=>starts++}),/did not confirm a clean stop/);
  assert.equal(starts,0);assert.equal(await fs.readFile(exe,'utf8'),'old');assert.equal(JSON.parse(await fs.readFile(path.join(target,'upgrade.json'))).phase,'needs_review');
});

test('systemd identity excludes changing run metadata but keeps arguments',()=>{
  const {systemdCommand}=require('../scripts/service-upgrade-platform.cjs'),prefix='{ path=/opt/service/bin/server ; argv[]=/opt/service/bin/server --config /etc/server.conf ; ignore_errors=no';
  assert.equal(systemdCommand(prefix+' ; start_time=[yesterday] ; pid=100 ; status=0 }'),systemdCommand(prefix+' ; start_time=[today] ; pid=200 ; status=0 }'));
  assert.notEqual(systemdCommand(prefix+' ; start_time=[] }'),systemdCommand(prefix.replace('server.conf','different.conf')+' ; start_time=[] }'));
});

test('authenticated database identity must match its selected service, including the PostgreSQL service launcher',()=>{
  const {databaseProcessMatches:matches}=require('../scripts/service-upgrade-platform.cjs');
  assert.equal(matches('mysql',{pid:12,parent:1},{pid:12}),true);
  assert.equal(matches('mysql',{pid:12,parent:13},{pid:13}),false);
  assert.equal(matches('postgresql',{pid:12,parent:13},{pid:13}),true);
  for(const service of ['postgresql','mysql','mariadb','mongodb','redis'])assert.equal(matches(service,{pid:12,parent:13},{pid:99}),false);
  assert.equal(matches('mysql',null,{pid:12}),false);
});

test('database restoration resumes after the original data rename and retains post-upgrade writes',async t=>{
  const root=await fixture(t),data=path.join(root,'data'),target=path.join(root,'update'),backup=path.join(target,'database-backup'),prepared=path.join(root,'data.manager-restore-'+randomUUID()),operationId=randomUUID(),retained=data+'.manager-recovery-'+operationId;
  await fs.mkdir(backup,{recursive:true});await fs.mkdir(data);await fs.mkdir(prepared);await fs.writeFile(path.join(backup,'record'),'before');await fs.writeFile(path.join(data,'record'),'writes after update');await fs.copyFile(path.join(backup,'record'),path.join(prepared,'record'));
  const manifest={verified:true,data,files:{record:createHash('sha256').update('before').digest('hex')}};await upgrade.atomic(path.join(target,'database-backup.json'),manifest);
  const journal={kind:'files',phase:'needs_review',started:true,files:[],dataRestore:{phase:'moving',prepared,retained}};await upgrade.atomic(path.join(target,'upgrade.json'),journal);await fs.rename(data,retained);
  const platform=require('../scripts/service-upgrade-platform.cjs');await platform.restoreDatabase({databaseDataPath:data,operationId},target,journal);assert.equal(await fs.readFile(path.join(data,'record'),'utf8'),'before');assert.equal(await fs.readFile(path.join(retained,'record'),'utf8'),'writes after update');
  await platform.restoreDatabase({databaseDataPath:data,operationId},target,journal);assert.equal(journal.dataRestore.phase,'restored');await fs.writeFile(path.join(backup,'extra'),'unexpected');await assert.rejects(platform.verifyBackup(backup,manifest),/inventory changed/);
});

test('binary restoration refuses third-party changes and can be retried after a completed restore',async t=>{
  const root=await fixture(t),exe=path.join(root,'engine'),source=path.join(root,'candidate'),target=path.join(root,'update');await fs.writeFile(exe,'old');await fs.writeFile(source,'new');await upgrade.replaceFiles(target,[{source,destination:exe}],async()=>{});
  await fs.writeFile(exe,'external edit');await assert.rejects(upgrade.restoreFiles(path.join(target,'upgrade.json')),/changed installation file/);assert.equal(await fs.readFile(exe,'utf8'),'external edit');await fs.writeFile(exe,'new');await upgrade.restoreFiles(path.join(target,'upgrade.json'));await upgrade.restoreFiles(path.join(target,'upgrade.json'));assert.equal(await fs.readFile(exe,'utf8'),'old');
});
test('private browser switches complete releases, retains sessions and rolls back failed activation',async t=>{
  const root=await fixture(t),agent=path.join(root,'agent'),old=path.join(root,'old'),source=path.join(root,'source');await fs.mkdir(agent);await fs.mkdir(old);await fs.mkdir(source);await fs.mkdir(path.join(source,'phpMyAdmin-5.2.3-all-languages/libraries/classes'),{recursive:true});await fs.writeFile(path.join(source,'phpMyAdmin-5.2.3-all-languages/libraries/classes/Version.php'),"<?php const VERSION = '5.2.3';");await fs.writeFile(path.join(source,'phpMyAdmin-5.2.3-all-languages/index.php'),'new');await fs.writeFile(path.join(old,'index.php'),'old');await fs.writeFile(path.join(old,'config.inc.php'),'existing config');await fs.writeFile(path.join(root,'php.ini'),'private ini');await fs.mkdir(path.join(root,'sessions'));await fs.writeFile(path.join(root,'sessions','existing'),'existing session');
  const config={version:'5.2.2',clientRoot:old,phpCgi:process.execPath,phpIni:path.join(root,'php.ini'),secret:'a'.repeat(64),sessionRoot:path.join(root,'sessions'),tempRoot:root};await fs.writeFile(path.join(agent,'database-browser.json'),JSON.stringify(config));
  const archive=path.join(root,'release.tar.gz');await upgrade.run('tar',['-czf',archive,'-C',source,'phpMyAdmin-5.2.3-all-languages']);const bytes=await fs.readFile(archive),previousFetch=global.fetch;global.fetch=async()=>new Response(bytes);t.after(()=>{global.fetch=previousFetch});
  const plan={service:'phpmyadmin',mode:'update',version:'5.2.3',operationId:randomUUID(),agentRoot:agent,downloads:{update:{version:'5.2.3',url:'https://vendor.invalid/release',sha256:createHash('sha256').update(bytes).digest('hex'),root:'phpMyAdmin-5.2.3-all-languages',format:'tar.gz'}}},target=path.join(root,'upgrade');
  await upgrade.browserPrepare(plan,target);assert.equal(JSON.parse(await fs.readFile(path.join(agent,'database-browser.json'))).clientRoot,old);
  await upgrade.browserActivate(plan,target,async dir=>{const value=JSON.parse(await fs.readFile(path.join(dir,'database-browser.json')));assert.equal(await fs.readFile(path.join(value.clientRoot,'config.inc.php'),'utf8'),'existing config');assert.equal(value.secret,config.secret)});
  assert.equal(JSON.parse(await fs.readFile(path.join(agent,'database-browser.json'))).version,'5.2.3');assert.equal(await fs.readFile(path.join(old,'index.php'),'utf8'),'old');assert.equal(await fs.readFile(path.join(config.sessionRoot,'existing'),'utf8'),'existing session');
  await upgrade.browserRecover(plan,target,async()=>{});assert.deepEqual(JSON.parse(await fs.readFile(path.join(agent,'database-browser.json'))),config);
  const second=path.join(root,'second'),next={...plan,operationId:randomUUID()};await upgrade.browserPrepare(next,second);await assert.rejects(upgrade.browserActivate(next,second,async dir=>{if(dir===agent)throw Error('actual-account failure')}),/actual-account failure/);assert.deepEqual(JSON.parse(await fs.readFile(path.join(agent,'database-browser.json'))),config);
});
