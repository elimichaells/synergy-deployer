'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),load=require('./server-module.cjs');
for(const acquired of [false,true])test(acquired?'failed recovery admission releases the acquired lock':'concurrent recovery stops before accessing the target',async()=>{
  class ApiError extends Error{constructor(message,status){super(message);this.status=status}}
  let released=0,closed=0,reads=0,unlocked=0;
  const module=load('lib/remote-services.ts',{
    './api':{ApiError},'./audit':{},'./db':{query:async sql=>({rows:sql.includes('managed_servers')?[{id:'fixture',enabled:true,enrolled_at:'yes',platform:'win32',metrics:{}}]:[]}),db:{connect:async()=>({query:async sql=>{if(sql.includes('pg_advisory_unlock'))unlocked++;return {rows:[{locked:acquired}]}},release:()=>released++})}},
    './managed-servers':{ensureManagedServers:async()=>{},uuid:()=>{}},'./secret-crypto':{},
    './server-ssh':{sshTarget:()=>({host:'fixture'}),sshCredentials:()=>({}),credentialSecrets:()=>[],connectSsh:async()=>({end:()=>closed++}),sftpSession:async()=>{reads++;throw Error('Must not access the target')}},
    '@/scripts/remote-service-policy.cjs':require('../scripts/remote-service-policy.cjs'),'@/scripts/manager-agent.cjs':{redact:value=>value},
    './remote-runtime-catalog':{},'./remote-service-downloads':{},'./service-upgrade-downloads':{},'./remote-tool-updates':{},
  });
  await assert.rejects(module.recoverRemoteService('fixture',{acceptFingerprint:true},'admin'),error=>error.status===409&&(acquired?/Reconnect/:/already recovering/).test(error.message));
  assert.equal(reads,0);assert.equal(released,1);assert.equal(closed,1);assert.equal(unlocked,acquired?1:0);
});
