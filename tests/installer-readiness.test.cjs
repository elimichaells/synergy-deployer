const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {verifyInstallation,verifyProxy}=require('../scripts/verify-manager-installation.cjs');

async function fixture(t,mode){
  const seen=[];
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');seen.push(url.pathname);
    res.setHeader('Content-Type','application/json');
    if(url.pathname==='/api/manager-health')return res.end(JSON.stringify({ready:mode!=='database-down',version:mode==='wrong-version'?'0.0.0':'2.27.0',nonce:url.searchParams.get('nonce')}));
    if(url.pathname==='/api/auth/login'){
      let text='';for await(const part of req)text+=part;
      if(JSON.parse(text).password!=='test-password'||mode==='bad-login'){res.statusCode=401;return res.end('{}')}
      res.setHeader('Set-Cookie','manager_session=test-session; HttpOnly; Secure; Path=/');return res.end('{}');
    }
    if(req.headers.cookie!=='manager_session=test-session'){res.statusCode=401;return res.end('{}')}
    if(url.pathname==='/api/auth/me')return res.end(JSON.stringify({user:{email:'admin@example.test',role:mode==='wrong-role'?'viewer':'admin'}}));
    if(url.pathname==='/api/servers'){
      res.statusCode=mode==='migration-failed'?500:200;
      return res.end(JSON.stringify({servers:[],role:'admin'}));
    }
    res.statusCode=404;res.end('{}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));
  return {seen,options:{baseUrl:'http://127.0.0.1:'+server.address().port,version:'2.27.0',email:'admin@example.test',password:'test-password',timeoutMs:150,pollMs:5}};
}
test('fresh installation verifies the release, database readiness, administrator session and server API',async t=>{
  const {seen,options}=await fixture(t,'healthy');
  assert.deepEqual(await verifyInstallation(options),{ready:true,version:'2.27.0',administratorLogin:true,serverManagement:true});
  assert.deepEqual(seen,['/api/manager-health','/api/auth/login','/api/auth/me','/api/servers']);
});
test('fresh installation cannot pass on the wrong release, unavailable database, broken login or missing schema',async t=>{
  for(const [mode,message] of [['database-down',/database readiness/],['wrong-version',/expected release/],['bad-login',/could not sign in/],['wrong-role',/session verification/],['migration-failed',/schema verification/]]){
    await t.test(mode,async sub=>{const {options}=await fixture(sub,mode);await assert.rejects(verifyInstallation(options),message)});
  }
});
test('installation verification never transmits credentials to a non-loopback address',async()=>{
  await assert.rejects(verifyInstallation({baseUrl:'https://example.com',version:'2.27.0',email:'admin@example.test',password:'secret'}),/local Manager listener/);
});
test('HTTPS readiness refuses nonlocal IPs and malformed origins before connecting',async()=>{
  for(const origin of ['https://203.0.113.1','https://[2001:db8::1]'])await assert.rejects(verifyProxy({origin}),/IP must belong to this server/);
  for(const origin of ['http://localhost','https://user:pass@localhost','https://localhost/path','https://localhost?query=1'])await assert.rejects(verifyProxy({origin}),/HTTPS origin/);
});
