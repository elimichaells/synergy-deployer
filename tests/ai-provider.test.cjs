const test=require('node:test'),assert=require('node:assert/strict');
const originalPreview=process.env.MANAGER_PREVIEW;delete process.env.MANAGER_PREVIEW;
test.after(()=>{if(originalPreview!==undefined)process.env.MANAGER_PREVIEW=originalPreview;});
const load=require('./server-module.cjs'),policy=require('../lib/ai-operations-policy.ts');
class ApiError extends Error {constructor(message,status){super(message);this.status=status;}}
function provider({enabled=true,recent=0,daily=0,locked=true}={}) {
 const records=[];let releases=0;
 const query=async(sql,args)=>{records.push({sql,args});return {rows:sql.includes('try_advisory')?[{locked}]:sql.includes('count(*)')?[{daily,recent}]:[]};};
 return {records,get releases(){return releases;},module:load('lib/ai-operations-provider.ts',{
  '@/lib/db':{query,db:{connect:async()=>({query,release:()=>releases++})}},
  '@/lib/ai-operations-store':{aiSettings:async()=>({enabled,configured:true,model:'fixture-model'}),aiKey:async()=> 'SECRET_API_KEY',ensureAiSchema:async()=>{}},
  '@/lib/ai-operations-policy':policy,'@/lib/api':{ApiError},
 })};
}
const health={checkedAt:new Date().toISOString(),stale:false,unavailable:false,snapshot:{apps:[{name:'private-app',status:'online',restarts:0}],checks:[]},incidents:[]};
test('provider uses bounded structured output without tool access, storage or raw application identity',async()=>{
 const p=provider(),old=global.fetch;let body,url;
 global.fetch=async(u,request)=>{url=u;body=JSON.parse(request.body);return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({summary:'No failures observed',evidence:[],recommendations:['observe'],limitations:['Readiness is sampled']})}]}]});};
 try{
 const result=await p.module.diagnoseWithAi(health,'actor');
 assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(body.store,false);assert.equal(body.max_output_tokens,1800);
 assert.equal(body.tools,undefined);assert.equal(body.text.format.strict,true);assert.doesNotMatch(body.input,/private-app|SECRET/);
 assert.equal(result.source,'openai');assert.equal(result.mapping[0].name,'private-app');
 assert.ok(p.records.some(r=>r.sql.includes("status='succeeded'")));assert.equal(p.releases,1);
 }finally{global.fetch=old;}
});
test('provider failures never expose response bodies or authentication keys',async()=>{
 const p=provider(),old=global.fetch;
 global.fetch=async()=>new Response('private provider error SECRET_API_KEY',{status:401});
 try{await assert.rejects(p.module.diagnoseWithAi(health,'actor'),e=>e.status===502&&!e.message.includes('SECRET'));
 assert.doesNotMatch(JSON.stringify(p.records),/SECRET_API_KEY|private provider/);assert.equal(p.releases,1);
 }finally{global.fetch=old;}
});
test('disabled connection, stale evidence, concurrent calls and request limits fail before a provider request',async()=>{
 const old=global.fetch;let calls=0;global.fetch=async()=>{calls++;throw Error('Unexpected network');};
 try {
 for(const options of [{enabled:false},{recent:1},{daily:50},{locked:false}])await assert.rejects(provider(options).module.diagnoseWithAi(health,'actor'),e=>[409,429].includes(e.status));
 await assert.rejects(provider().module.diagnoseWithAi({...health,stale:true},'actor'),e=>e.status===409);assert.equal(calls,0);
 }finally{global.fetch=old;}
});
test('incomplete and schema-invalid responses remain failures, never recovery instructions',async()=>{
 const old=global.fetch;
 try{
 for(const response of [{status:'incomplete',output:[]},{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"summary":"Run command","evidence":[],"recommendations":["restart_all"],"limitations":[]}'}]}]}]){
 global.fetch=async()=>Response.json(response);const p=provider();
 await assert.rejects(p.module.diagnoseWithAi(health,'actor'),e=>e.status===502);
 assert.ok(!p.records.some(r=>r.sql.includes("status='succeeded'")));
 }
 }finally{global.fetch=old;}
});
test('AI settings return only key presence and encrypt replacement keys',async()=>{
 const writes=[];const query=async(sql,args)=>{if(sql.startsWith('insert'))writes.push(args);return {rows:sql.startsWith('select enabled')?[{enabled:false,model:'fixture',key_ciphertext:'cipher',recovery_enabled:true}]:[]};};
 const store=load('lib/ai-operations-store.ts',{'@/lib/db':{query,db:{connect:async()=>({query,release:()=>{}})}},
 '@/lib/secret-crypto':{encryptSecret:s=>'encrypted:'+s,decryptSecret:s=>s},'@/lib/api':{ApiError}});
 const result=await store.saveAiSettings({enabled:true,recoveryEnabled:true,model:'fixture',apiKey:'SECRET-12345678901234567890'});
 assert.match(writes[0][2],/^encrypted:/);assert.equal(result.configured,true);
 assert.doesNotMatch(JSON.stringify(result),/cipher|SECRET/);
 await assert.rejects(store.saveAiSettings({enabled:true,recoveryEnabled:true,model:'bad model'}),e=>e.status===400);
});
