'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
class ApiError extends Error{constructor(message,status){super(message);this.status=status;}}
const {saveEnvironmentFile}=require('./server-module.cjs')('lib/environment-file.ts',{'./api':{ApiError}});
test('environment saves preserve complete files, separate local values and refuse stale editors',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-env-atomic-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'.env'),local=path.join(root,'.env.local'),first='# comments stay\nVALUE=old\n',next='# comments stay\nVALUE=new\n';
  await saveEnvironmentFile(file,first,'');await saveEnvironmentFile(local,'VALUE=local\n','');
  await saveEnvironmentFile(file,next,first);assert.equal(await fs.readFile(file,'utf8'),next);assert.equal(await fs.readFile(local,'utf8'),'VALUE=local\n');
  await assert.rejects(saveEnvironmentFile(file,'VALUE=stale',first),e=>e.status===409);assert.equal(await fs.readFile(file,'utf8'),next);
  assert.deepEqual((await fs.readdir(root)).sort(),['.env','.env.local']);
});
test('environment saves reject directory and linked targets without changing peer data',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-env-target-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const peer=path.join(root,'peer'),file=path.join(root,'.env');await fs.writeFile(peer,'preserve');await fs.mkdir(file);
  await assert.rejects(saveEnvironmentFile(file,'new',''),e=>e.status===409);await fs.rmdir(file);
  try{await fs.symlink(peer,file);}catch(e){if(process.platform==='win32'&&e.code==='EPERM'){t.diagnostic('Windows account cannot create file symlinks');return;}throw e;}
  await assert.rejects(saveEnvironmentFile(file,'new','preserve'),e=>e.status===409);assert.equal(await fs.readFile(peer,'utf8'),'preserve');
});
