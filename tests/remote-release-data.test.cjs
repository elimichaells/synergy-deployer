'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const data=require('../scripts/remote-release-data.cjs');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-data-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const previous=path.join(root,'old'),candidate=path.join(root,'new'),backup=path.join(root,'backup');await fs.mkdir(previous);await fs.mkdir(candidate);return{root,previous,candidate,backup};}
async function put(root,file,value){await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),value);}
const read=(root,file)=>fs.readFile(path.join(root,file),'utf8');
test('remote releases retain uploads and ignored SQLite files, preserve fresh settings, and recover new writes',async t=>{
  const f=await fixture(t);await put(f.previous,'uploads/photo.txt','user upload');await put(f.previous,'db/app.sqlite','database before');await put(f.previous,'.env','old settings');await put(f.candidate,'.env','new settings');await put(f.candidate,'uploads/seed.txt','repository seed');await put(f.previous,'node_modules/cache','dependency');
  const moves=await data.plan(f.previous,f.candidate,f.backup,['db/','.env','node_modules/']);let snapshots=[];const persist=async()=>snapshots.push(JSON.parse(JSON.stringify(moves)));
  await data.activate(moves,persist);assert.equal(await read(f.candidate,'uploads/photo.txt'),'user upload');assert.equal(await read(f.candidate,'.env'),'new settings');assert.equal(await read(f.previous,'node_modules/cache'),'dependency');
  await put(f.candidate,'db/app.sqlite','database after readiness');await put(f.candidate,'uploads/new.txt','upload during failed readiness');
  await data.restore(moves,persist);assert.equal(await read(f.previous,'db/app.sqlite'),'database after readiness');assert.equal(await read(f.previous,'uploads/new.txt'),'upload during failed readiness');assert.equal(await read(f.candidate,'uploads/seed.txt'),'repository seed');
  await data.restore(moves,persist);assert.ok(snapshots.some(s=>s.some(m=>m.stage==='moving')));
});
test('recovery handles every persisted activation boundary and does not overwrite ambiguous copies',async t=>{
  for(const boundary of ['displacing','moving','active']){
    const f=await fixture(t);await put(f.previous,'uploads/file','keep');await put(f.candidate,'uploads/seed','seed');const moves=await data.plan(f.previous,f.candidate,f.backup,[]);let snapshot;
    await assert.rejects(data.activate(moves,async()=>{if(moves[0].stage===boundary){snapshot=JSON.parse(JSON.stringify(moves));throw Error('power loss');}}),/power loss/);
    await data.restore(snapshot,async()=>{});assert.equal(await read(f.previous,'uploads/file'),'keep');assert.equal(await read(f.candidate,'uploads/seed'),'seed');
  }
  const f=await fixture(t);await put(f.previous,'uploads/file','keep');const moves=await data.plan(f.previous,f.candidate,f.backup,[]);await data.activate(moves,async()=>{});await put(f.previous,'uploads/other','unexpected');await assert.rejects(data.restore(moves,async()=>{}),/both releases/);assert.equal(await read(f.candidate,'uploads/file'),'keep');
});
test('persistent links are rebased within the release and traversal or linked ancestors are rejected',async t=>{
  const f=await fixture(t);await put(f.previous,'storage/file','keep');await fs.mkdir(path.join(f.previous,'public'));await fs.symlink(path.join(f.previous,'storage'),path.join(f.previous,'public/storage'),process.platform==='win32'?'junction':'dir');
  const moves=await data.plan(f.previous,f.candidate,f.backup,[]);await data.activate(moves,async()=>{});assert.equal(await read(f.candidate,'public/storage/file'),'keep');await data.restore(moves,async()=>{});assert.equal(await read(f.previous,'public/storage/file'),'keep');
  assert.throws(()=>data.retainedPaths(['../escape']),/Invalid/);assert.throws(()=>data.retainedPaths(['C:/escape']),/Invalid/);
  await fs.symlink(f.previous,path.join(f.candidate,'public'),process.platform==='win32'?'junction':'dir').catch(async error=>{if(error.code!=='EEXIST')throw error;await fs.rmdir(path.join(f.candidate,'public'));await fs.symlink(f.previous,path.join(f.candidate,'public'),process.platform==='win32'?'junction':'dir');});
  await assert.rejects(data.plan(f.previous,f.candidate,f.backup,[]),/ancestor/);
});
