const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
test('release verification rejects version mismatch, incorrect tags and dirty source',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-release-check-'));
 const git=(...args)=>cp.execFileSync('git',args,{cwd:root,windowsHide:true,stdio:'pipe'});
 const run=(...args)=>cp.spawnSync(process.execPath,['scripts/check-release.cjs',...args],{cwd:root,windowsHide:true,encoding:'utf8'});
 try {
  await fs.mkdir(path.join(root,'scripts'));await fs.copyFile(path.join(__dirname,'../scripts/check-release.cjs'),path.join(root,'scripts/check-release.cjs'));
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({version:'1.0.0'}));await fs.writeFile(path.join(root,'package-lock.json'),JSON.stringify({version:'1.0.0',packages:{'':{version:'1.0.0'}}}));await fs.writeFile(path.join(root,'.gitignore'),'release-source.json\n');
  git('init','-q');git('config','user.name','Release Test');git('config','user.email','release-test@example.invalid');git('add','.');git('commit','-qm','Fixture');
  assert.equal(run('v1.0.0','--write').status,0);const receipt=JSON.parse(await fs.readFile(path.join(root,'release-source.json')));assert.equal(receipt.sourceDirty,false);assert.match(receipt.sourceCommit,/^[a-f0-9]{40}$/);
  assert.notEqual(run('v2.0.0').status,0);await fs.writeFile(path.join(root,'unexpected.txt'),'changed');assert.notEqual(run().status,0);await fs.unlink(path.join(root,'unexpected.txt'));
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({version:'1.1.0'}));assert.match(run().stderr,/versions do not match/);
 }finally {await fs.rm(root,{recursive:true,force:true});}
});
