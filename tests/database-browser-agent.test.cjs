'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {handle}=require('../scripts/database-browser-agent.cjs');

test('database browser CGI receives only its selected database and private PHP environment',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-browser-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const clientRoot=path.join(root,'client'),tempRoot=path.join(root,'temp'),sessionRoot=path.join(root,'sessions');for(const folder of [clientRoot,tempRoot,sessionRoot])await fs.mkdir(folder);
  await fs.writeFile(path.join(clientRoot,'index.php'),'fixture');await fs.writeFile(path.join(clientRoot,'app.css'),'body {}');await fs.writeFile(path.join(root,'agent.json'),'private agent credential');
  await fs.writeFile(path.join(root,'database-browser.json'),JSON.stringify({clientRoot,tempRoot,sessionRoot,phpCgi:process.execPath,phpIni:path.join(root,'private.ini'),secret:'ab'.repeat(32)}));
  const request={method:'POST',path:'index.php?route=/sql',body:Buffer.from('sql=select+1').toString('base64'),publicBase:'https://manager.test/api/database-browser/'+'a'.repeat(43)+'/',connection:{host:'127.0.0.1',port:3307,tls:false},cookie:'phpMyAdmin=fixture-session',contentType:'application/x-www-form-urlencoded',authorization:'Manager credentials must not be forwarded'};
  const result=await handle(root,'https://manager.test',request,null,async(config,env,body)=>{
    assert.equal(env.PHPMYADMIN_DB_PORT,'3307');assert.equal(env.SCRIPT_FILENAME,await fs.realpath(path.join(clientRoot,'index.php')));assert.equal(env.HTTP_COOKIE,'phpMyAdmin=fixture-session');assert.equal(env.HTTP_AUTHORIZATION,undefined);assert.equal(env.MANAGER_ENCRYPTION_KEY,undefined);assert.equal(body.toString(),'sql=select+1');
    return Buffer.from('Status: 200 OK\r\nContent-Type: text/html\r\nSet-Cookie: phpMyAdmin=next; HttpOnly\r\n\r\n<p>Database client</p>');
  });
  assert.equal(result.status,200);assert.match(Buffer.from(result.body,'base64').toString(),/Database client/);
  const css=await handle(root,'https://manager.test',{...request,method:'GET',path:'app.css',body:''},null,()=>{throw Error('Static files must not execute PHP')});assert.equal(css.headers[0][1],'text/css; charset=utf-8');
  for(const file of ['../agent.json','%2e%2e/agent.json','/agent.json','index.php:other','index.php%00'])await assert.rejects(handle(root,'https://manager.test',{...request,path:file},null),/Invalid/);
  await assert.rejects(handle(root,'https://different.test',request,null),/does not match/);
  await fs.symlink(path.join(root,'agent.json'),path.join(clientRoot,'outside.txt'),'file');await assert.rejects(handle(root,'https://manager.test',{...request,path:'outside.txt'},null),/outside/);
});
