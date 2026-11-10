'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),load=require('./server-module.cjs'),{randomUUID}=require('node:crypto');
test('database browser admission binds the selected connection, current admin and enabled agent',async()=>{
  const serverId=randomUUID(),otherId=randomUUID(),connectionId=randomUUID(),userId=randomUUID();let enabled=true,role='admin',browserInstalled=true;
  class ApiError extends Error{constructor(message,status){super(message);this.status=status}}
  const query=async(sql,args)=>{
    if(sql.startsWith('select enabled'))return{rows:[{enabled,last_seen_at:new Date().toISOString(),metrics:{capabilities:['database-browser-v1'],tools:{phpmyadmin:browserInstalled?'5.2.3':null}}}]};
    if(sql.startsWith('select id,provider'))return{rows:args[0]===serverId&&args[1]===connectionId?[{id:connectionId,provider:'mysql',host:'127.0.0.1',port:3307,tls_enabled:true,options:{}}]:[]};
    return{rowCount:enabled&&role==='admin'&&args[0]===serverId&&args[1]===userId&&args[2]===connectionId?1:0};
  };
  const module=load('lib/database-browser.ts',{'./api':{ApiError},'./db':{query},'./managed-servers':{ensureManagedServers:async()=>{},uuid:value=>{assert.match(value,/^[a-f0-9-]{36}$/);return value}},'./audit':{audit:async()=>{}},'../scripts/manager-agent.cjs':{DATABASE_BROWSER_CAPABILITY:'database-browser-v1'}});
  await assert.rejects(module.openDatabaseBrowser(otherId,connectionId,'https://manager.test',userId),/not found on this server/);
  browserInstalled=false;await assert.rejects(module.openDatabaseBrowser(serverId,connectionId,'https://manager.test',userId),/Install phpMyAdmin/);browserInstalled=true;
  const lease=await module.openDatabaseBrowser(serverId,connectionId,'https://manager.test',userId);assert.deepEqual(await module.authorizeDatabaseBrowser(lease.token),{serverId,userId,connectionId});
  await assert.rejects(module.closeDatabaseBrowser(lease.token,otherId,userId),/not found/);
  role='viewer';await assert.rejects(module.authorizeDatabaseBrowser(lease.token),/revoked/);assert.throws(()=>module.databaseBrowser.inspect(lease.token),/expired/);
  role='admin';const next=await module.openDatabaseBrowser(serverId,connectionId,'https://manager.test',userId);enabled=false;await assert.rejects(module.authorizeDatabaseBrowser(next.token),/revoked/);
});
test('sandbox preference storage is bounded and does not read the real browser storage or cookies',()=>{
  const vm=require('node:vm'),window={},document={};for(const name of ['localStorage','sessionStorage'])Object.defineProperty(window,name,{configurable:true,get(){throw Error('Manager storage must never be read')}});Object.defineProperty(document,'cookie',{configurable:true,get(){throw Error('Manager cookies must never be read')}});
  vm.runInNewContext(require('../scripts/database-browser-sandbox.cjs').replace(/^<script>|<\/script>$/g,''),{window,document,DOMException});
  window.localStorage.setItem('theme','dark');assert.equal(window.localStorage.theme,'dark');assert.equal(window.localStorage.getItem('missing'),null);window.sessionStorage.query='select 1';assert.equal(window.localStorage.query,undefined);assert.throws(()=>window.localStorage.setItem('large','x'.repeat(270000)),/full/);document.cookie='theme=light; path=/';assert.equal(document.cookie,'theme=light');window.localStorage.clear();assert.equal(window.localStorage.length,0);
});
