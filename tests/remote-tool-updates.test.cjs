'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),load=require('./server-module.cjs');
const updates=load('lib/remote-tool-updates.ts',{});
test('vendor update versions preserve database series and distinguish MariaDB and client tools',()=>{
  assert.equal(updates.detectedToolVersion('composer','PHP version 8.3.6\nComposer version 2.11.2 2026-10-20'),'2.11.2');
  assert.equal(updates.detectedToolVersion('postgresql','psql (PostgreSQL) 18.5'),'18.5');
  assert.equal(updates.detectedToolVersion('mysql','mysql Ver 15.1 Distrib 10.11.12-MariaDB'),'10.11.12');
  assert.equal(updates.releaseVersion('postgresql','tags',[{name:'REL_19_0'},{name:'REL_18_6'},{name:'REL_18_5'}],'18.4'),'18.6');
  assert.equal(updates.releaseVersion('mysql','tags',[{name:'mysql-9.7.2'},{name:'mysql-8.4.13'},{name:'mysql-8.4.12'}],'8.4.8'),'8.4.13');
  assert.equal(updates.releaseVersion('python','tags',[{name:'v3.16.0a1'},{name:'v3.15.0'},{name:'v3.14.5'}],'3.14.2'),'3.14.5');
  assert.equal(updates.releaseVersion('git','tag',{tag_name:'v2.56.0.windows.4'},'2.55.0'),'2.56.0');
  assert.equal(updates.releaseVersion('php','php',{version:'8.3.36'},'8.3.35'),'8.3.36');
  assert.equal(updates.releaseVersion('mysql','refs',[{ref:'refs/tags/mysql-8.4.13'},{ref:'refs/tags/mysql-8.4.14-rc'}],'8.4.8'),'8.4.13');
  assert.equal(updates.releaseVersion('mariadb','refs',[{ref:'refs/tags/mariadb-11.4.8'},{ref:'refs/tags/mariadb-11.4.11'}],'11.4.4'),'11.4.11');
  assert.throws(()=>updates.releaseVersion('postgresql','tags',[{name:'REL_19_0'}],'18.5'),/compatible/);
  assert.equal(updates.updateRisk('8.4.12','8.4.13'),'patch');assert.equal(updates.updateRisk('24.9.1','24.10.0'),'minor');assert.equal(updates.updateRisk('24.9.1','26.1.0'),'major');
});
test('update discovery caches vendor results and retains errors instead of claiming no updates',async()=>{
  const original=global.fetch;let requests=0;global.fetch=async url=>{requests++;if(String(url).includes('caddyserver'))return Response.json({tag_name:'v2.12.1'});return new Response('',{status:503})};
  try{
    const checked=await updates.remoteToolUpdate('caddy','linux','v2.10.1',true);assert.equal(checked.latestVersion,'2.12.1');assert.ok(checked.updateCheckedAt);
    const cached=await updates.remoteToolUpdate('caddy','linux','v2.10.1');assert.deepEqual(cached,checked);assert.equal(requests,1);
    assert.equal((await updates.remoteToolUpdate('caddy','linux','v2.12.1')).latestVersion,null,'a changed installation invalidates its old result');
    const failed=await updates.remoteToolUpdate('sling','linux','Version: 1.5.1',true);assert.equal(failed.updateCheckSupported,true);assert.equal(failed.updateCheckedAt,null);assert.match(failed.updateCheckError,/unavailable/);
    assert.equal((await updates.remoteToolUpdate('redis','win32','memurai-cli 4.1.0',true)).updateCheckSupported,false);
  }finally{global.fetch=original}
});
test('one failed runtime catalog does not hide another connected-server tool update',async()=>{
  const catalog=load('lib/remote-service-catalog.ts',{}),server={platform:'linux',metrics:{arch:'x64',tools:{node:'v24.0.0',caddy:'v2.10.1',phpmyadmin:'5.2.3',mysql:'mysql Ver 15.1 Distrib 10.6.16-MariaDB'}}};
  class ApiError extends Error{}
  const module=load('lib/remote-runtimes.ts',{'./api':{ApiError},'./db':{query:async sql=>({rows:sql.includes('managed_servers')?[server]:[]})},'./managed-servers':{ensureManagedServers:async()=>{},uuid:()=>{}},'./remote-service-catalog':catalog,'./remote-tool-updates':{...updates,remoteToolUpdate:async id=>({latestVersion:id==='caddy'?'2.12.1':null,updateCheckSupported:true,updateCheckedAt:new Date().toISOString(),updateCheckError:null,updateSourceUrl:null})},'./remote-runtime-catalog':{remoteRuntimeCatalog:async()=>{throw Error('Official runtime catalog is unavailable')}}});
  const rows=await module.listRemoteRuntimes('fixture',true);assert.match(rows.find(row=>row.id==='node').updateCheckError,/unavailable/);assert.equal(rows.find(row=>row.id==='caddy').updateAvailable,true);assert.equal(rows.find(row=>row.id==='caddy').canUpdate,true);assert.equal(rows.find(row=>row.id==='caddy').updateMode,'maintenance','existing service upgrades require the reviewed maintenance workflow');assert.equal(rows.find(row=>row.id==='phpmyadmin').canReuse,false);
  assert.equal(rows.find(row=>row.id==='mysql').updateService,'mariadb','MariaDB compatibility clients must open MariaDB maintenance');
});
