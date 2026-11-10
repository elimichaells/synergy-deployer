'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createRelay}=require('../scripts/database-browser-relay.cjs');
const connection={id:'database-one',provider:'mysql',host:'127.0.0.1',port:3306,password:'must-not-forward'};

test('database browser requests stay scoped to a session, server and one claimed operation',async()=>{
  const relay=createRelay({pollMs:1}),session=relay.open('server-one',connection,'https://manager.test','admin');
  const pending=relay.enqueue(session.token,{method:'POST',path:'index.php?route=/sql',body:Buffer.from('sql=select+1'),cookie:'manager_session=never-forward'});
  assert.equal((await relay.claim('server-two')).request,null);
  const {request}=await relay.claim('server-one');assert.ok(request);assert.equal(request.cookie,'');assert.equal(request.connection.password,undefined);assert.equal(Buffer.from(request.body,'base64').toString(),'sql=select+1');
  assert.equal((await relay.claim('server-one')).request,null,'a lost poll response never replays a mutation');
  assert.throws(()=>relay.report('server-two',{...request,status:200,headers:[],body:''}),/Invalid.*receipt/);
  assert.throws(()=>relay.report('server-one',{...request,claimToken:'wrong',status:200,headers:[],body:''}),/Invalid.*receipt/);
  relay.report('server-one',{...request,status:200,headers:[['Content-Type','text/html'],['Set-Cookie','phpMyAdmin=private-session; HttpOnly; Secure'],['Set-Cookie','manager_session=untrusted']],body:Buffer.from('<p>Connected</p>').toString('base64')});
  const response=await pending;assert.equal(response.status,200);assert.equal(response.headers['Set-Cookie'],undefined);assert.match(response.headers['Content-Security-Policy'],/sandbox allow-scripts allow-forms allow-downloads;/);assert.doesNotMatch(response.headers['Content-Security-Policy'],/allow-same-origin|allow-top-navigation/);assert.equal(response.headers['Access-Control-Allow-Origin'],'null');
  const next=relay.enqueue(session.token,{method:'GET',path:'index.php'}),second=(await relay.claim('server-one')).request;assert.equal(second.cookie,'phpMyAdmin=private-session');
  relay.report('server-one',{...second,status:200,headers:[['Set-Cookie','__Secure-phpMyAdmin_https=secure-session; Secure; HttpOnly']],body:''});await next;
  const secure=relay.enqueue(session.token,{method:'GET',path:'index.php'}),third=(await relay.claim('server-one')).request;assert.match(third.cookie,/__Secure-phpMyAdmin_https=secure-session/);relay.report('server-one',{...third,status:200,headers:[],body:''});await secure;relay.close(session.token);
});

test('database browser rejects path escapes, external redirects and expired sessions',async()=>{
  let now=1000;const relay=createRelay({now:()=>now,pollMs:1}),session=relay.open('server',connection,'https://manager.test','admin');
  for(const path of ['../agent.json','%2e%2e/agent.json','/outside','%2foutside','x%00.php','x%5cy.php','index.php:other'])assert.throws(()=>relay.enqueue(session.token,{method:'GET',path}),/Invalid/);
  const pending=relay.enqueue(session.token,{method:'GET',path:'index.php'}),rejected=assert.rejects(pending,/expired/),request=(await relay.claim('server')).request;
  assert.throws(()=>relay.report('server',{...request,status:302,headers:[['Location','https://elsewhere.test/']],body:''}),/left its session/);
  now+=31*60*1000;assert.throws(()=>relay.headers(session.token),/expired/);await rejected;
});
