// Runs only from the administrator's hash-pinned bootstrap runtime, outside Manager.
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const S=require('./manager-update-state.cjs');
const P=require('./manager-update-package.cjs');
const W=require('./manager-update-worker.cjs');
function installed(root) {
  const build=S.json(path.join(root,'.next/required-server-files.json'));
  const version=build.config?.env?.NEXT_PUBLIC_MANAGER_VERSION;
  if(!version)throw new Error('Cannot identify the installed production build');
  let receipt;try{receipt=S.json(path.join(root,'release-source.json'))}catch(e){if(e.code!=='ENOENT')throw e}
  return {version,localBootstrap:receipt?.sourceDirty===true && receipt?.buildKind==='local-bootstrap' && receipt.version===version};
}
async function verify(root,file,dir) {
  root=path.resolve(root);dir=path.resolve(dir);
  if(fs.existsSync(dir))throw new Error('Use a fresh bootstrap verification folder');
  if(path.parse(root).root.toLowerCase()!==path.parse(dir).root.toLowerCase())throw new Error('Bootstrap and Manager must use the same volume');
  const current=installed(root);
  if(S.compare(current.version,'2.17.0')<0 || S.compare(current.version,'2.21.0')>0)throw new Error('This one-time bootstrap supports Manager 2.17–2.20 and the local 2.21 preview');
  await fsp.mkdir(dir,{recursive:true});
  const m=await P.verifyAndStage(file,dir,current.version,path.join(__dirname,'update-trusted-root.json'),{bootstrap:true,localBootstrap:current.localBootstrap});
  S.atomic(path.join(dir,'inventory.json'),await P.inventory(path.join(dir,'stage')));
  S.atomic(path.join(dir,'bootstrap.json'),{managerRoot:root,fromVersion:current.version,version:m.version,commit:m.sourceCommit});
  console.log('Publisher signature, platform, release identity and all staged files verified.');
}
async function install(root,prepared) {
  root=path.resolve(root);prepared=path.resolve(prepared);
  const c=S.config(root),receipt=S.json(path.join(prepared,'bootstrap.json'));
  if(path.resolve(receipt.managerRoot).toLowerCase()!==root.toLowerCase() || installed(root).version!==receipt.fromVersion)throw new Error('The installed Manager changed after package verification');
  // The package has already been authenticated; this recheck catches subsequent changes.
  await W.integrity(prepared);
  await W.assertIdle(c);
  const lock=path.join(c.stateRoot,'prepare.lock');await fsp.mkdir(lock);
  let id,dir;
  try {
    const old=S.currentJob(c);if(old&&!S.TERMINAL.includes(old.state.phase))throw new Error('An update is already in progress');
    id=crypto.randomUUID();dir=S.jobDir(c,id);
    await fsp.rename(prepared,dir);
    const state={id,source:'bootstrap',userId:'local-administrator',phase:'ready',fromVersion:receipt.fromVersion,legacyHealth:S.compare(receipt.fromVersion,'2.21.0')<0,version:receipt.version,commit:receipt.commit,createdAt:new Date().toISOString(),events:[]};
    S.save(dir,state,'ready','Signed bootstrap verified; independent recovery is registered');
    S.atomic(path.join(c.stateRoot,'current.json'),{id});
    S.save(dir,state,'queued','One-time upgrade requested by the local administrator');
  }finally{await fsp.rmdir(lock)}
  console.log('Installing Manager '+receipt.version+'. Recovery and progress: '+dir);
  // A scheduled worker may win the lock. Wait for its terminal state as well.
  const deadline=Date.now()+45*60_000;
  while(Date.now()<deadline) {
    await W.main(path.join(root,'.manager-updater.json'),'run');
    const state=S.json(path.join(dir,'state.json'));
    if(state.phase==='succeeded'){console.log('Manager '+state.version+' is healthy. Future updates are available in Settings.');return;}
    if(S.TERMINAL.includes(state.phase)||state.phase==='recovery_failed')throw new Error('Upgrade ended in '+state.phase+'. '+state.events.at(-1)?.message+' Recovery: '+dir);
    await new Promise(resolve=>setTimeout(resolve,3000));
  }
  throw new Error('Upgrade is still running. Inspect '+dir+'; independent recovery remains enabled.');
}
if(require.main===module){const [mode,...args]=process.argv.slice(2);(mode==='verify'?verify(...args):mode==='install'?install(...args):Promise.reject(new Error('Use verify or install'))).catch(e=>{console.error(e.message);process.exitCode=1})}
module.exports={installed,verify,install};
