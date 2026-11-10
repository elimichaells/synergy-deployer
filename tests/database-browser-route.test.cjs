'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),load=require('./server-module.cjs');
const {createRelay,LIMIT}=require('../scripts/database-browser-relay.cjs');
function session(){
  const relay=createRelay({pollMs:50}),lease=relay.open('server',{id:'db',provider:'mysql',host:'127.0.0.1',port:3307},'https://manager.test','admin');
  let allowed=true;
  const route=load('app/api/database-browser/[token]/[[...path]]/route.ts',{'@/lib/database-browser':{
    databaseBrowser:relay,LIMIT,authorizeDatabaseBrowser:async token=>{
      if(!allowed)throw Object.assign(Error('Access revoked'),{status:403});
      return relay.inspect(token);
    }
  }});
  return {relay,lease,route,revoke(){allowed=false}};
}
test('capability route keeps multipart bytes, response downloads and authentication scoped',async()=>{
  const {relay,lease,route,revoke}=session(),context={params:Promise.resolve({token:lease.token})};
  try{
    const body=Buffer.from('--fixture\r\nContent-Disposition: form-data; name="sql"\r\n\r\nSELECT 1;\r\n--fixture--'),pending=route.POST(new Request(lease.url+'?route=/import',{method:'POST',headers:{'Content-Type':'multipart/form-data; boundary=fixture','Cookie':'manager_session=must-not-forward'},body}),context);
    const {request}=await relay.claim('server');assert.ok(request);assert.deepEqual(Buffer.from(request.body,'base64'),body);assert.equal(request.contentType,'multipart/form-data; boundary=fixture');assert.equal(request.cookie,'');
    relay.report('server',{...request,status:200,headers:[['Content-Type','application/sql'],['Content-Disposition','attachment; filename="fixture.sql"']],body:Buffer.from('SELECT 1;').toString('base64')});
    const response=await pending;assert.equal(response.status,200);assert.equal(await response.text(),'SELECT 1;');assert.match(response.headers.get('content-disposition'),/fixture.sql/);assert.match(response.headers.get('content-security-policy'),/sandbox/);
    const preflight=await route.OPTIONS(new Request(lease.url,{method:'OPTIONS'}),context);assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),'null');
    revoke();const denied=await route.GET(new Request(lease.url),context);assert.equal(denied.status,403);
  }finally{relay.close(lease.token)}
});
test('capability route rejects oversized streaming bodies and canonicalizes its root',async()=>{
  const {relay,lease,route}=session(),context={params:Promise.resolve({token:lease.token})};
  try{
    const oversized=await route.POST(new Request(lease.url,{method:'POST',body:new Uint8Array(LIMIT+1)}),context);assert.equal(oversized.status,413);assert.match(await oversized.text(),/8 MB/);
    const root=lease.url.replace('/index.php',''),redirect=await route.GET(new Request(root+'?route=/'),context);assert.equal(redirect.status,307);assert.equal(redirect.headers.get('location'),lease.url+'?route=/');
  }finally{relay.close(lease.token)}
});
