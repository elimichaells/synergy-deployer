const {test}=require('node:test'),assert=require('node:assert/strict'),load=require('./server-module.cjs');
test('repeated storage reads share one agent job while different server reads remain independent',async()=>{
  const {storageRead}=load('lib/storage-request-queue.ts',{});let release,started=0,second=false;
  const work=()=>{started++;return new Promise(resolve=>{release=()=>resolve({status:200,body:{private:'fixture'}})})};
  const first=storageRead('a','tables',work),repeated=storageRead('a','tables',work),next=storageRead('a','rows',async()=>{second=true;return{status:200,body:{}}});
  await storageRead('b','tables',async()=>({status:200,body:{}}));assert.equal(started,1);assert.equal(second,false);assert.equal(first,repeated);release();await first;await next;assert.equal(second,true);
  let retried=0;await storageRead('a','tables',async()=>{retried++;return{status:200,body:{}}});assert.equal(retried,1);
});
test('a failed read releases the server queue without replaying a mutation',async()=>{
  const {storageRead}=load('lib/storage-request-queue.ts',{});
  const first=storageRead('a','broken',async()=>{throw Error('Disconnected')});const next=storageRead('a','tables',async()=>({status:200,body:{}}));await assert.rejects(first,/Disconnected/);assert.equal((await next).status,200);
});
