'use strict';
// The same transaction is used by local and SSH maintenance. No package-wide
// update, database initialization, proxy rewrite or unrelated restart occurs.
const fs=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process'),{randomUUID,createHash}=require('node:crypto');
const policy=require('./service-upgrade-policy.cjs');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const exists=file=>fs.lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e});
async function atomic(file,value){const temporary=file+'.'+randomUUID()+'.tmp',before=await exists(file);await fs.writeFile(temporary,typeof value==='string'?value:JSON.stringify(value),{flag:'wx',mode:before?.mode||0o600});try{if(before&&process.platform!=='win32')await fs.chown(temporary,before.uid,before.gid);await fs.rename(temporary,file)}finally{await fs.unlink(temporary).catch(()=>{})}}
function inside(root,file){const relative=path.relative(root,file);return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)}
async function regular(file,directory=false){const absolute=path.resolve(file),s=await fs.lstat(absolute);if(s.isSymbolicLink()||!(directory?s.isDirectory():s.isFile()))throw Error('Upgrade paths must be regular local '+(directory?'directories':'files'));let parent=path.dirname(absolute);while(parent!==path.dirname(parent)){if((await fs.lstat(parent)).isSymbolicLink())throw Error('Upgrade paths must not traverse links');parent=path.dirname(parent)}return s;}
async function replaceAtomic(source,destination,metadata){
  await regular(source);await regular(path.dirname(destination),true);
  const temporary=destination+'.'+randomUUID()+'.tmp';
  try{await fs.copyFile(source,temporary);if(metadata?.mode)await fs.chmod(temporary,metadata.mode);if(process.platform!=='win32'&&Number.isInteger(metadata?.uid))await fs.chown(temporary,metadata.uid,metadata.gid);await fs.rename(temporary,destination)}finally{await fs.unlink(temporary).catch(()=>{})}
}
async function run(file,args,options={}){return new Promise((resolve,reject)=>{const p=spawn(file,args,{windowsHide:true,env:options.env||process.env,cwd:options.cwd,stdio:['ignore','pipe','pipe']});let output='',failed=false;const timer=setTimeout(()=>{failed=true;p.kill()},options.timeout||120000);for(const stream of [p.stdout,p.stderr])stream.on('data',b=>{output+=b;if(output.length>10000000){failed=true;p.kill()}});p.on('error',e=>{clearTimeout(timer);reject(e)});p.on('close',code=>{clearTimeout(timer);if(code||failed)reject(Error('Upgrade command failed: '+path.basename(file)+(failed?' (timeout or output limit)':'')+'\n'+output.slice(-2000)));else resolve(output)});});}
async function files(root){await regular(root,true);const found=[];async function visit(folder){for(const item of await fs.readdir(folder,{withFileTypes:true})){const file=path.join(folder,item.name);if(item.isSymbolicLink())throw Error('Linked files cannot be included in an upgrade');if(item.isDirectory())await visit(file);else if(item.isFile())found.push(path.relative(root,file));else throw Error('Special files cannot be included in an upgrade')}}await visit(root);return found;}
async function download(asset,file){if(!/^https:\/\//.test(asset.url)||!/^[a-f0-9]{64}$/.test(asset.sha256))throw Error('Invalid verified update archive');const response=await fetch(asset.url,{signal:AbortSignal.timeout(600000)});if(!response.ok||!response.body)throw Error('Update download failed');const out=await fs.open(file,'wx',0o600),digest=createHash('sha256');let size=0;try{for await(const chunk of response.body){size+=chunk.length;if(size>800*1024*1024)throw Error('Update exceeds its size limit');digest.update(chunk);await out.write(chunk)}await out.sync();}finally{await out.close()}if(digest.digest('hex')!==asset.sha256)throw Error('Update checksum mismatch');}
async function unpack(asset,target){
  await fs.mkdir(target,{recursive:false,mode:0o700});const archive=path.join(target,'download'),content=path.join(target,'content');await download(asset,archive);await fs.mkdir(content);
  if(asset.format==='file')await fs.rename(archive,path.join(content,asset.executable));
  else{
    // tar on supported Windows and Linux hosts supports zip as well. Reject
    // links before extraction, and validate the resulting tree a second time.
    const zip=asset.format==='zip'&&process.platform!=='win32',listing=await run(zip?'unzip':'tar',zip?['-Z','-1',archive]:['-tf',archive]);for(const line of listing.split(/\r?\n/).filter(Boolean)){if(line.includes('\\')||line.startsWith('/')||line.split('/').includes('..')||line.includes(':'))throw Error('Unsafe update archive path')}
    const detail=await run(zip?'zipinfo':'tar',zip?['-l',archive]:['-tvf',archive]);if(detail.split(/\r?\n/).filter(Boolean).some(line=>zip?/^[lbcp]/.test(line):!/^[-d]/.test(line)))throw Error('Update archives cannot contain links or special files');
    await run(zip?'unzip':'tar',zip?['-q',archive,'-d',content]:['-xf',archive,'-C',content],{timeout:600000});await files(content);
  }
  let root=asset.root?path.join(content,asset.root):content;
  if(asset.root==='single'){const entries=await fs.readdir(content,{withFileTypes:true});if(entries.length!==1||!entries[0].isDirectory())throw Error('Unexpected vendor archive layout');root=path.join(content,entries[0].name)}
  if(asset.build)await run('make',['-C',root,'-j2','BUILD_TLS=yes','BUILD_WITH_MODULES=no','MALLOC=libc'],{timeout:600000});
  return root;
}
async function browserStage(plan,target){
  const marker=path.join(plan.agentRoot,'database-browser.json'),previous=await fs.readFile(marker,'utf8'),old=JSON.parse(previous);await regular(marker);await regular(old.clientRoot,true);await regular(await fs.realpath(old.phpCgi));await regular(old.phpIni);
  policy.validate('phpmyadmin',old.version,plan.version,process.platform);
  if(plan.currentVersion&&old.version!==plan.currentVersion)throw Error('The private browser changed after review');
  const root=await unpack(plan.downloads.update,target),clientRoot=path.join(target,'client');await fs.rename(root,clientRoot);
  if(!(await exists(path.join(clientRoot,'index.php')))||!(await exists(path.join(clientRoot,'libraries/classes/Version.php'))))throw Error('Invalid phpMyAdmin release');
  const declared=await fs.readFile(path.join(clientRoot,'libraries/classes/Version.php'),'utf8');if(!declared.includes("'"+plan.version+"'"))throw Error('phpMyAdmin archive version does not match the review');
  // Keep configuration, secrets and session directories; the entire old code
  // tree remains available for in-flight requests and explicit rollback.
  await fs.copyFile(path.join(old.clientRoot,'config.inc.php'),path.join(clientRoot,'config.inc.php'));await fs.mkdir(path.join(clientRoot,'.ini-scan'),{recursive:true});
  const config={...old,clientRoot,version:plan.version};await atomic(path.join(target,'database-browser.json'),config);
  return {marker,previous,config};
}
async function browserActivate(plan,target,check){
  const state=JSON.parse(await fs.readFile(path.join(target,'upgrade.json'),'utf8'));if(state.operationId!==plan.operationId||state.kind!=='browser'||state.phase!=='prepared')throw Error('No prepared browser update matches this operation');
  const {marker,previous,config}=state;if(await fs.readFile(marker,'utf8')!==previous)throw Error('The browser changed after preparation');
  await check(target);state.phase='activating';await atomic(path.join(target,'upgrade.json'),state);await atomic(marker,config);
  try{await check(plan.agentRoot);state.phase='complete';await atomic(path.join(target,'upgrade.json'),state);return {version:config.version,path:config.clientRoot,backup:target};}
  catch(error){if(await fs.readFile(marker,'utf8')!==JSON.stringify(config)){state.phase='needs_review';await atomic(path.join(target,'upgrade.json'),state);throw Error('The browser selection changed during verification; inspect it before recovery')}await atomic(marker,previous);await check(plan.agentRoot);state.phase='rolled_back';await atomic(path.join(target,'upgrade.json'),state);throw error;}
}
async function browserPrepare(plan,target){const state=await browserStage(plan,target);await atomic(path.join(target,'upgrade.json'),{...state,kind:'browser',operationId:plan.operationId,phase:'prepared'});return state.config;}
async function browserRecover(plan,target,check){const state=JSON.parse(await fs.readFile(path.join(target,'upgrade.json'),'utf8'));if(state.operationId!==plan.operationId||state.kind!=='browser')throw Error('Recovery does not match this browser update');const actual=await fs.readFile(state.marker,'utf8');if(actual!==state.previous&&actual!==JSON.stringify(state.config))throw Error('A later browser change prevents recovery');await atomic(state.marker,state.previous);await check(plan.agentRoot);state.phase='rolled_back';await atomic(path.join(target,'upgrade.json'),state);return {status:'failed',message:'Previous browser restored; both release directories and sessions were preserved.'};}

// A binary transaction journals each replacement before it happens. Recovery
// refuses third-party edits and never restores database contents automatically.
async function replaceFiles(target,replacements,check,adapter={}){
  const journalFile=path.join(target,'upgrade.json'),journal={kind:'files',phase:'prepared',files:[],started:false};
  await fs.mkdir(path.join(target,'backup'),{recursive:true,mode:0o700});
  for(let i=0;i<replacements.length;i++){const {source,destination}=replacements[i];await regular(source);const stat=await exists(destination);if(stat)await regular(destination);const before=stat?await fs.readFile(destination):null,after=await fs.readFile(source),backup=path.join(target,'backup',String(i));if(before)await fs.writeFile(backup,before,{flag:'wx',mode:0o600});journal.files.push({destination,source,backup,before:before?hash(before):null,after:hash(after),mode:stat?.mode,uid:stat?.uid,gid:stat?.gid,applied:false});}
  await atomic(journalFile,journal);let stopped=false;
  try{
    await adapter.before?.();await adapter.capture?.(target);journal.phase='stopping';await atomic(journalFile,journal);await adapter.stop?.();stopped=true;await adapter.backup?.(target);journal.phase='replacing';await atomic(journalFile,journal);
    for(const item of journal.files){const actual=await exists(item.destination);if(actual)await regular(item.destination);if((actual?hash(await fs.readFile(item.destination)):null)!==item.before)throw Error('An installation file changed after review');item.applied=true;await atomic(journalFile,journal);await fs.mkdir(path.dirname(item.destination),{recursive:true});await replaceAtomic(item.source,item.destination,item);}
    journal.phase='starting';journal.started=true;await atomic(journalFile,journal);await adapter.start?.();await check();journal.phase='complete';await atomic(journalFile,journal);return {backup:target};
  }catch(error){
    if(!stopped&&journal.phase==='stopping'){journal.phase='needs_review';await atomic(journalFile,journal);throw Error('The selected service did not confirm a clean stop. Its files are unchanged; inspect its state before recovery. '+error.message)}
    if(stopped){try{await adapter.stop?.()}catch(stopError){journal.phase='needs_review';await atomic(journalFile,journal);throw Error('Cannot verify that the selected service stopped; recovery files retained. '+stopError.message)}if(journal.started&&adapter.database){journal.phase='needs_review';journal.error=error.message;await atomic(journalFile,journal);throw Error('The updated database did not pass verification. It is stopped; binaries, the cold backup and data are retained for reviewed recovery. '+error.message)}
      await restoreFiles(journalFile);await adapter.start?.();}
    throw error;
  }
}
async function restoreFiles(journalFile){const journal=JSON.parse(await fs.readFile(journalFile,'utf8'));for(const item of [...journal.files].reverse()){if(!item.applied)continue;const actual=await exists(item.destination);if(actual)await regular(item.destination);const digest=actual?hash(await fs.readFile(item.destination)):null;if(digest!==item.after&&digest!==item.before)throw Error('A changed installation file prevents automatic rollback');if(digest===item.before)continue;if(item.before){await regular(item.backup);if(hash(await fs.readFile(item.backup))!==item.before)throw Error('The recovery copy failed verification');await replaceAtomic(item.backup,item.destination,item)}else await fs.unlink(item.destination)}journal.phase='rolled_back';await atomic(journalFile,journal);}
module.exports={atomic,inside,regular,files,run,download,unpack,browserPrepare,browserActivate,browserRecover,replaceFiles,restoreFiles,replaceAtomic};
if(require.main===module)(async()=>{const [action,file,target]=process.argv.slice(2),plan=JSON.parse(await fs.readFile(file,'utf8'));if(plan.service!=='phpmyadmin')throw Error('Unsupported browser operation');const check=root=>run(process.execPath,[path.join(__dirname,'database-browser-agent.cjs'),root]);if(action==='prepare')await browserPrepare(plan,target);else if(action==='activate')await browserActivate(plan,target,check);else if(action==='recover')await browserRecover(plan,target,check);else throw Error('Unknown upgrade action')})().catch(error=>{console.error(error.message);process.exitCode=1});
