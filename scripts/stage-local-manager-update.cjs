// Administrator CLI for the ONE-TIME bootstrap from a locally built and tested
// checkout. The web API has no unsigned-package or local-source bypass.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const S=require('./manager-update-state.cjs');
const {inventory,validateStage}=require('./manager-update-package.cjs');
async function stage(source,target) {
  source=path.resolve(source);target=path.resolve(target);
  if(source===target)throw new Error('Build in an isolated directory before staging a local update');
  const c=S.config(target),old=S.currentJob(c);
  if(old&&!S.TERMINAL.includes(old.state.phase))throw new Error('Another update is already in progress');
  const receipt=S.json(path.join(source,'release-source.json'));
  const installed=S.json(path.join(target,'release-source.json'));
  if(S.compare(receipt.version,installed.version)<=0)throw new Error('Local build must be newer than the installed release');
  await validateStage(source,receipt);
  const id=crypto.randomUUID(),dir=S.jobDir(c,id);
  const state={id,source:'local',userId:'local-administrator',phase:'preparing',fromVersion:installed.version,legacyHealth:S.compare(installed.version,'2.21.0')<0,version:receipt.version,commit:receipt.sourceCommit,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),events:[]};
  await fs.mkdir(dir,{recursive:true});S.save(dir,state,'preparing','Preparing the locally built bootstrap release');S.atomic(path.join(c.stateRoot,'current.json'),{id});
  try {
    for(const name of S.ITEMS) {
      try{await fs.access(path.join(source,name))}catch{continue}
      await fs.cp(path.join(source,name),path.join(dir,'stage',name),{recursive:true,filter:file=>!path.relative(source,file).replaceAll('\\','/').startsWith('.next/cache')});
    }
    S.atomic(path.join(dir,'inventory.json'),await inventory(path.join(dir,'stage')));
    S.save(dir,state,'ready','Local bootstrap release staged and hashed. This is an administrator build, not a signed GitHub release.');
    console.log(JSON.stringify({id,dir,phase:state.phase,version:state.version}));
  }catch(error){S.save(dir,state,'failed',error.message);throw error;}
}
if(require.main===module)stage(...process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={stage};
