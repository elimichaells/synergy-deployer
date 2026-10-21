const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
function load(file,mocks,extra={}){
 const exports={};const code=ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'..',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 vm.runInNewContext(code,{exports,require:name=>name in mocks?mocks[name]:require(name),process:{env:{GITHUB_CLIENT_ID:'old-environment-id'}},...extra},{filename:file});return exports;
}
test('GitHub client ID seeds once, updates immediately, and survives a fresh settings cache',async()=>{
 const rows=new Map();const mocks={
  '@/lib/paths':{webRoot:()=>'/fixture',backupsRoot:()=>'/fixture/backups',postgresBin:()=>'/fixture/pg'},
  '@/lib/db':{query:async(sql,args)=>{if(sql.startsWith('SELECT'))return {rows:[...rows].map(([key,value])=>({key,value}))};if(!sql.includes('DO NOTHING')||!rows.has(args[0]))rows.set(...args);return {rows:[]}}},
 };
 const settings=load('lib/settings.ts',mocks);
 await settings.seedSettingsFromEnv();assert.equal(await settings.getSetting('GITHUB_CLIENT_ID'),'old-environment-id');
 await settings.updateSettings({GITHUB_CLIENT_ID:'database-id'});assert.equal(await settings.getSetting('GITHUB_CLIENT_ID'),'database-id');
 const restarted=load('lib/settings.ts',mocks);await restarted.seedSettingsFromEnv();assert.equal(await restarted.getSetting('GITHUB_CLIENT_ID'),'database-id');
 await restarted.updateSettings({GITHUB_CLIENT_ID:''});await restarted.seedSettingsFromEnv();assert.equal(await restarted.getSetting('GITHUB_CLIENT_ID'),'');
});
const common={
 'next/server':{NextResponse:{json:(body,options={})=>({body,status:options.status||200})}},
 '@/lib/auth':{getSessionFromCookie:async()=>({id:'admin',role:'admin'})},
 '@/lib/rbac':{requireRole:(user,roles)=>{if(!user||!roles.includes(user.role))throw Error('Forbidden')}},
 '@/lib/api':{jsonError:error=>({status:403,body:{error:error.message}})},
 '@/lib/github-connections':{createGitHubConnection:()=>{throw Error('Unexpected connection mutation')}},
};
for(const route of ['device','poll'])test(`GitHub ${route} uses the saved database client ID and explains missing configuration`,async()=>{
 let value='database-only-id',requests=[];
 const handler=load(`app/api/auth/github/${route}/route.ts`,{...common,'@/lib/settings':{getSetting:async key=>{assert.equal(key,'GITHUB_CLIENT_ID');return value}}},{fetch:async(url,options)=>{requests.push(JSON.parse(options.body));return {ok:true,json:async()=>({error:'authorization_pending',device_code:'fixture'})}}});
 const response=await handler.POST({json:async()=>({deviceCode:'test-code'})});assert.equal(response.status,200);assert.equal(requests[0].client_id,'database-only-id');assert.equal(requests[0].client_secret,undefined);
 value='';const missing=await handler.POST({json:async()=>({deviceCode:'test-code'})});assert.equal(missing.status,409);assert.match(missing.body.error,/Settings/);assert.equal(requests.length,1);
});
test('only administrators can save a valid client ID and audit records omit its value',async()=>{
 let role='viewer',updates=[],audits=[];
 const api=load('app/api/settings/route.ts',{...common,'@/lib/auth':{getSessionFromCookie:async()=>({id:'fixture',role})},'@/lib/settings':{updateSettings:async value=>updates.push(value)},'@/lib/db':{query:async(...args)=>audits.push(args)}});
 const put=value=>api.PUT({json:async()=>({GITHUB_CLIENT_ID:value})});
 assert.equal((await put('client-id')).status,403);assert.equal(updates.length,0);
 role='admin';assert.equal((await put('invalid id')).status,400);assert.equal(updates.length,0);
 assert.equal((await put('  valid.client-id  ')).status,200);assert.equal(updates[0].GITHUB_CLIENT_ID,'valid.client-id');assert.ok(!JSON.stringify(audits).includes('valid.client-id'));
});
