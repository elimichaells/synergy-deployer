const test=require('node:test');
const assert=require('node:assert/strict');
const {conditionsFor,advanceState}=require('../scripts/server-monitor-policy.cjs');
const {diskCapacityError}=require('../lib/disk-capacity.ts');
const GB=1024**3;
const start=Date.UTC(2026,9,14);
const sample=(overrides={})=>({at:start,disks:[{name:'C:',total:300*GB,free:100*GB}],logs:[],memory:{total:16*GB,free:8*GB},pm2Updates:0,apps:[],checks:[],pm2Error:false,collectorError:null,...overrides});
test('critical disk and process storms alert immediately, ordinary failures debounce',()=>{
  assert.equal(advanceState(null,sample({disks:[{name:'C:',total:300*GB,free:10*GB}]})).incidents.length,1);
  assert.equal(advanceState(null,sample({pm2Updates:5})).incidents[0].severity,'critical');
  const failed={checks:[{name:'Caddy',ok:false,status:null,ms:4000}]};
  const first=advanceState(null,sample(failed));assert.equal(first.incidents.length,0);
  const second=advanceState(first,sample({...failed,at:start+60000}));assert.equal(second.incidents.length,1);
  const once=advanceState(second,sample({at:start+120000}));assert.equal(once.incidents[0].resolvedAt,undefined);
  const twice=advanceState(once,sample({at:start+180000}));assert.ok(twice.incidents[0].resolvedAt);
});
test('stale samples cannot count as consecutive observations',()=>{
  const failed={pm2Error:true};const first=advanceState(null,sample(failed));
  assert.equal(advanceState(first,sample({...failed,at:start+600000})).incidents.length,0);
});
test('unknown collection never resolves a real incident or invents missing apps',()=>{
  const first=advanceState(null,sample({pm2Updates:5}));
  let state=advanceState(first,sample({at:start+60000,collectorError:'process checks'}));
  state=advanceState(state,sample({at:start+120000,collectorError:'process checks'}));
  assert.equal(state.incidents.find(i=>i.key==='pm2-updates').resolvedAt,undefined);
  assert.equal(conditionsFor(sample({pm2Error:true,apps:[{name:'app',status:null}]})).filter(c=>c.key.startsWith('app:')).length,0);
});
test('intentionally stopped apps are quiet, missing apps and restart bursts are detected',()=>{
  assert.equal(conditionsFor(sample({apps:[{name:'staging',status:'stopped'}]})).length,0);
  assert.equal(conditionsFor(sample({apps:[{name:'prod',status:null}]}))[0].key,'app:prod');
  const before=sample({apps:[{name:'prod',status:'online',restarts:1,uptime:start}]});
  assert.ok(conditionsFor(sample({at:start+300000,apps:[{name:'prod',status:'online',restarts:8,uptime:start+299000}]}),[before]).some(c=>c.key==='restarts:prod'));
});
test('rapid disk growth forecasts risk; cleanup does not predict exhaustion',()=>{
  const before=sample();
  assert.ok(conditionsFor(sample({at:start+600000,disks:[{name:'C:',total:300*GB,free:90*GB}]}),[before]).some(c=>c.key==='disk-growth:C:'));
  assert.ok(!conditionsFor(sample({at:start+600000,disks:[{name:'C:',total:300*GB,free:110*GB}]}),[before]).some(c=>c.key.startsWith('disk-growth')));
});
test('new critical incidents deduplicate and recovered history is bounded',()=>{
  let state=advanceState(null,sample({pm2Updates:6}));
  const id=state.incidents[0].id;state=advanceState(state,sample({at:start+60000,pm2Updates:8}));
  assert.equal(state.incidents.length,1);assert.equal(state.incidents[0].id,id);
  assert.equal(state.incidents[0].message,'8 PM2 update processes are running at once.');
});
test('deployment disk guard reserves space and fails closed on invalid readings',()=>{
  assert.equal(diskCapacityError(100*GB,300*GB),null);
  assert.match(diskCapacityError(30*GB,300*GB),/Not enough disk space/);
  assert.match(diskCapacityError(14*GB,100*GB),/Not enough disk space/);
  assert.match(diskCapacityError(NaN,100*GB),/could not be measured/);
});
test('low disk blocks an installation and a build before acquiring a database lock or running commands',async()=>{
  const load=require('./server-module.cjs');
  const api=load('lib/deployment-capacity.ts',{'@/lib/db':{db:{connect:()=>assert.fail('must not acquire a lock')}},'./disk-capacity':{requireDeploymentDiskSpace:()=>{throw new Error('Not enough disk space')}}});
  await assert.rejects(api.withInstallationSlot(()=>assert.fail('must not install'),()=>{},()=>{}),/Not enough disk space/);
  await assert.rejects(api.withBuildSlot(()=>assert.fail('must not build'),()=>{},()=>{}),/Not enough disk space/);
});
