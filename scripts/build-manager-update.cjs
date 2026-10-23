const fs=require('node:fs/promises');
const path=require('node:path');
const tar=require('tar');
const {ITEMS,atomic,json}=require('./manager-update-state.cjs');
const {REPOSITORY,sha,verifyProvenance}=require('./manager-update-package.cjs');
async function verify(dir,provenance) {
  verifyProvenance(await fs.readFile(path.join(dir,'manifest.json')),json(provenance),json(path.join(__dirname,'update-trusted-root.json')));
  console.log('Release attestation verified with the same offline trust policy used by installed Managers.');
}
async function prepare(root,out) {
  const pkg=json(path.join(root,'package.json')),receipt=json(path.join(root,'release-source.json'));
  if(receipt.version!==pkg.version || receipt.sourceDirty) throw new Error('A verified tagged release receipt is required');
  await fs.mkdir(out,{recursive:true});
  const names=[];for(const name of ITEMS)try{await fs.access(path.join(root,name));names.push(name)}catch{}
  if(!names.includes('.next') || !names.includes('node_modules'))throw new Error('Build the release and install its locked dependencies first');
  await tar.c({cwd:root,file:path.join(out,'payload.tar.gz'),gzip:true,portable:true,filter:n=>!n.startsWith('.next/cache')&&!n.startsWith('node_modules/.cache')},names);
  const payload=path.join(out,'payload.tar.gz');
  atomic(path.join(out,'manifest.json'),{format:1,repository:REPOSITORY,version:pkg.version,minimumVersion:'2.21.0',...(pkg.version==='2.21.0'?{bootstrapMinimumVersion:'2.17.0'}:{}),sourceCommit:receipt.sourceCommit,schemaCompatibility:'additive',platform:process.platform,arch:process.arch,nodeMajor:Number(process.versions.node.split('.')[0]),payloadBytes:(await fs.stat(payload)).size,payloadSha256:await sha(payload)});
}
async function assemble(dir,provenance,out) {
  const m=json(path.join(dir,'manifest.json'));
  await fs.copyFile(provenance,path.join(dir,'provenance.json'));
  await fs.mkdir(out,{recursive:true});
  const file=path.join(out,`manager-update-${m.platform}-${m.arch}-node${m.nodeMajor}.tar`);
  await tar.c({cwd:dir,file,portable:true},['manifest.json','provenance.json','payload.tar.gz']);
  console.log(file);
}
if(require.main===module) {
  const [mode,...args]=process.argv.slice(2);
  (mode==='prepare'?prepare(...args):mode==='verify'?verify(...args):mode==='assemble'?assemble(...args):Promise.reject(new Error('Use prepare, verify or assemble'))).catch(e=>{console.error(e.message);process.exitCode=1});
}
module.exports={prepare,verify,assemble};
