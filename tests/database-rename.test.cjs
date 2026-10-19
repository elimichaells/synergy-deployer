const test = require('node:test');
const assert = require('node:assert/strict');
const loadModule = require('./server-module.cjs');
const policy = require('../lib/database-rename-policy.ts');
const discovery = require('../lib/database-discovery-policy.ts');
const serverPolicy = require('../lib/server-database-policy.ts');

test('rename review includes URLs, custom settings, every file and local host aliases without credentials', () => {
  const env = { DATABASE_URL: 'postgresql://owner:secret@localhost:5433/shared', DATABASE_OWNER_URL: 'postgresql://owner:secret@127.0.0.1:5433/shared',
    DATABASE_HOST: 'localhost', DATABASE_NAME: 'shared', DATABASE_PORT: '5433', OTHER_URL: 'postgresql://owner:secret@localhost:5432/shared',
    SERVICE_HOST: '127.0.0.1', SERVICE_PORT: '5433', SERVICE_DATABASE: 'shared' };
  const result = policy.renameEnvSettings('.env.production.local', env, {host:'127.0.0.1',port:5433,database:'shared'});
  assert.deepEqual(new Set(result), new Set(['.env.production.local:DATABASE_URL','.env.production.local:DATABASE_OWNER_URL','.env.production.local:DATABASE_NAME','.env.production.local:SERVICE_DATABASE']));
  assert.ok(!JSON.stringify(result).includes('secret'));
});
test('invalid, injection, truncation, identical and reserved names are rejected', () => {
  for (const name of [null,'','same','postgres','template0','Template1','x'.repeat(64),'a";drop database b;--','1abc','with space']) assert.ok(policy.renameNameError(name,'same'));
  assert.equal(policy.renameNameError('valid_name$1','same'),null);
});

function harness(options = {}) {
  const calls = [], files = [];
  class ApiError extends Error { constructor(message,status) { super(message); this.status=status; } }
  const services = [{id:'service1',project_id:'app1',host:'localhost',port:5433,env_prefix:'PRIMARY'}, {id:'service2',project_id:'app2',host:'127.0.0.1',port:5433,env_prefix:'SHARED'}, {id:'other',project_id:'app3',host:'localhost',port:5432,env_prefix:'OTHER'}];
  const managerQuery = async (sql, params=[]) => {
    calls.push({side:'manager',sql,params});
    if (sql.startsWith('select connection_id')) return {rows:[{connection_id:'server',database_name:'old'}]};
    if (sql.includes('pg_try_advisory_lock')) return {rows:[{locked:options.locked !== false}]};
    if (sql.startsWith('select s.id')) return {rows:services};
    if (sql.startsWith('select id,name,environment,root_path')) return {rows:['app1','app2','app3'].map(id => ({id,name:id,environment:'production',root_path:id}))};
    if (sql.includes('to_regclass')) return {rows:[{name: null}]};
    if (sql.startsWith('select id from deployments')) return {rows:options.deployment?[{id:'deploy'}]:[]};
    if (sql.startsWith('insert into database_renames')) return {rows:[{id:'job'}]};
    if (sql.startsWith('update project_data_services')) { if(options.metadataFailure) throw new Error('metadata unavailable'); return {rows:[{id:'service1'},{id:'service2'}]}; }
    if (sql==='commit' && options.commitFailure) throw new Error('commit uncertain');
    return {rows:[]};
  };
  class Client {
    async connect() { calls.push({side:'remote',sql:'connect'}); }
    async end() { calls.push({side:'remote',sql:'end'}); }
    async query(sql,params=[]) {
      calls.push({side:'remote',sql,params});
      if (sql.includes('from pg_database')) return {rows:params[0]==='old' || options.collision?[{}]:[]};
      if (sql.includes('from pg_stat_activity')) return {rows: options.sessions?[{application:'app1',count:2}]:[]};
      return {rows:[]};
    }
  }
  const mod = loadModule('lib/database-rename.ts', {
    pg:{Client}, 'fs/promises':{readFile:async file => {files.push(file); if(file.endsWith('.env')) return Buffer.from('DATABASE_URL=postgresql://u:secret@localhost:5433/old'); const error = new Error('missing'); error.code='ENOENT'; throw error; }},
    '@/lib/db':{query:managerQuery,db:{connect:async()=>({query:managerQuery,release:()=>calls.push({side:'manager',sql:'release'})})}},
    '@/lib/api':{ApiError}, '@/lib/data-services':{ensureDataServicesSchema:async()=>{},getSecretConnection:async()=>({id:'server',name:'Apps',provider:'postgresql',host:'127.0.0.1',port:5433,username:'admin',options:{}}),connectionPassword:()=> 'secret'},
    '@/lib/db-admin':{quoteIdent:value=>`"${value.replaceAll('"','""')}"`}, '@/lib/database-discovery-policy':discovery,
    '@/lib/server-database-policy':serverPolicy, '@/lib/database-rename-policy':policy,
  });
  return {mod,calls,files};
}
test('all sharing apps and alias links reviewed; metadata and audit updated; files never written',async()=>{
  const {mod,calls,files}=harness();
  const result=await mod.renameDatabase('service1','new_name','old',true);
  assert.equal(result.apps.length,3); // app3 is discovered in env even though its tracked DB is elsewhere
  assert.ok(files.some(file=>file.endsWith('.env.production.local')));
  const updated=calls.find(call=>call.sql.startsWith('update project_data_services'));
  assert.deepEqual(updated.params,['new_name',['service1','service2'],'old']);
  assert.ok(calls.some(call=>call.sql==='alter database "old" rename to "new_name"'));
  assert.ok(calls.some(call=>call.sql.startsWith('insert into audit_logs')));
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.ok(calls.findIndex(call=>call.side==='remote'&&call.sql==='commit') < calls.findIndex(call=>call.side==='manager'&&call.sql==='commit'));
});
for (const [label,options] of [['active sessions',{sessions:true}],['deployment',{deployment:true}],['collision',{collision:true}],['another operation',{locked:false}]]) {
  test(`${label} prevents database mutation`,async()=>{
    const {mod,calls}=harness(options);
    await assert.rejects(mod.renameDatabase('service1','new_name','old',true));
    assert.ok(!calls.some(call=>call.sql.startsWith('alter database')));
  });
}
test('explicit old name and environment acknowledgment required',async()=>{
  const {mod,calls}=harness();
  await assert.rejects(mod.renameDatabase('service1','new_name','wrong',true));
  await assert.rejects(mod.renameDatabase('service1','new_name','old',false));
  assert.ok(!calls.some(call=>call.sql.startsWith('alter database')));
});
test('metadata failure rolls back both databases before commit',async()=>{
  const {mod,calls}=harness({metadataFailure:true});
  await assert.rejects(mod.renameDatabase('service1','new_name','old',true));
  assert.ok(calls.some(call=>call.side==='remote'&&call.sql==='rollback'));
  assert.ok(calls.some(call=>call.side==='manager'&&call.sql==='rollback'));
  assert.ok(!calls.some(call=>call.sql==='commit'));
});
test('uncertain cross-server commit is retained for review instead of silently retried',async()=>{
  const {mod,calls}=harness({commitFailure:true});
  await assert.rejects(mod.renameDatabase('service1','new_name','old',true),/could not be verified/);
  assert.ok(calls.some(call=>call.sql.startsWith('update database_renames set status=$2')&&call.params[1]==='needs_review'));
});

for (const role of [null,'viewer','operator','admin']) {
  test('rename endpoint restricts GET and POST: '+role,async()=>{
    let invoked=0;
    const route=loadModule('app/api/storage/[id]/rename/route.ts', {
      'next/server':{NextResponse:{json:(body,options)=>({body,status:options?.status||200})}},
      '@/lib/auth':{getSessionFromCookie:async()=>role?{role,id:'user'}:null},
      '@/lib/rbac':{requireRole:(user,roles)=>{if(!user||!roles.includes(user.role))throw Object.assign(new Error('forbidden'),{status:user?403:401})}},
      '@/lib/api':{jsonError:error=>({status:error.status||500})},
      '@/lib/database-rename':{planDatabaseRename:async()=>{invoked++;return{}},renameDatabase:async()=>{invoked++;return{}}}
    });
    const context={params:Promise.resolve({id:'service'})};
    const get=await route.GET(new Request('http://localhost'),context);
    const post=await route.POST(new Request('http://localhost',{method:'POST',body:'{}'}),context);
    assert.equal(get.status,role==='admin'?200:role?403:401);
    assert.equal(post.status,get.status);
    assert.equal(invoked,role==='admin'?2:0);
  });
}
