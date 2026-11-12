'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const upgrade=require('./service-upgrade.cjs'),policy=require('./service-upgrade-policy.cjs'),platform=require('./service-upgrade-platform.cjs'),{adapterFor}=platform;
const tool={postgresql:'psql',mongodb:'mongod',sqlserver:'sqlcmd',angular:'ng'};
async function binaryVersion(service,file,context={}){
  if(service==='pm2'||service==='angular'){
    if(service==='angular'&&path.basename(path.dirname(file))==='.bin')return JSON.parse(await fs.readFile(path.join(path.dirname(file),'../@angular/cli/package.json'),'utf8')).version;
    file=await fs.realpath(file);
    let folder=path.dirname(file);while(folder!==path.dirname(folder)){try{const metadata=JSON.parse(await fs.readFile(path.join(folder,'package.json'),'utf8'));if(metadata.name===(service==='pm2'?'pm2':'@angular/cli'))return metadata.version}catch{}folder=path.dirname(folder)}throw Error('Cannot identify the installed npm package');
  }
  if(service==='composer')return policy.version(await upgrade.run(context.php,[file,'--version'],{env:{...process.env,COMPOSER_DISABLE_NETWORK:'1',COMPOSER_NO_INTERACTION:'1'}}));
  const args=service==='caddy'?['version']:service==='sqlserver'?['--version']:['--version'];return policy.version(await upgrade.run(file,args));
}
async function npmUpdate(plan,target){
  const asset=plan.downloads.update,packageName=plan.service==='pm2'?'pm2':'@angular/cli';if(asset.package!==packageName||!['pm2','angular'].includes(plan.service))throw Error('Unsupported npm package update');
  const pathsFile=path.join(plan.agentRoot,'tool-paths.json'),previous=await fs.readFile(pathsFile,'utf8'),paths=JSON.parse(previous),npm=path.join(path.dirname(process.execPath),process.platform==='win32'?'node_modules/npm/bin/npm-cli.js':'../lib/node_modules/npm/bin/npm-cli.js');await upgrade.regular(npm);await fs.mkdir(target,{mode:0o700});
  await fs.writeFile(path.join(target,'package.json'),JSON.stringify({private:true,dependencies:{[asset.package]:plan.version}}),{flag:'wx'});await fs.writeFile(path.join(target,'.npmrc'),'registry=https://registry.npmjs.org/\nignore-scripts=true\n');
  const args=['--prefix',target,'--ignore-scripts','--no-audit','--no-fund','--engine-strict','--registry=https://registry.npmjs.org/','--userconfig='+path.join(target,'.npmrc')];
  await upgrade.run(process.execPath,[npm,'install','--package-lock-only',...args],{timeout:600000});const lock=JSON.parse(await fs.readFile(path.join(target,'package-lock.json'),'utf8')),entry=lock.packages?.['node_modules/'+packageName];if(entry?.version!==plan.version||entry?.integrity!==asset.integrity)throw Error('The npm lockfile does not match the reviewed vendor release');
  await upgrade.run(process.execPath,[npm,'ci',...args],{timeout:600000});const cli=path.join(target,plan.service==='pm2'?'node_modules/pm2/bin/pm2':'node_modules/@angular/cli/bin/ng.js'),selected=plan.service==='pm2'?cli:process.platform==='win32'?path.join(target,'node_modules/.bin/ng.cmd'):path.join(target,'node_modules/.bin/ng');if(await binaryVersion(plan.service,cli)!==plan.version)throw Error('Updated npm package version mismatch');
  if(plan.service==='angular')await upgrade.run(paths.node||process.execPath,[cli,'version'],{env:{...process.env,NG_CLI_ANALYTICS:'false'}});
  if(process.platform==='win32')await upgrade.run('icacls.exe',[target,'/grant','*S-1-5-19:(OI)(CI)'+(plan.service==='pm2'?'M':'RX')]);else{await upgrade.run('chmod',['-R','a+rX',target]);for(const folder of [path.dirname(target),path.dirname(path.dirname(target))])await upgrade.run('chmod',['a+rx',folder]);if(plan.service==='pm2')await upgrade.run('chown',['-R','manager-agent:manager-agent',target]);}
  if(await fs.readFile(pathsFile,'utf8')!==previous)throw Error('Tool selection changed during maintenance');
  if(plan.service==='pm2'){
    if(path.resolve(paths.pm2).toLowerCase()!==path.resolve(plan.path).toLowerCase())throw Error('Select this agent’s current PM2 installation for maintenance');
    paths.pm2=selected;await upgrade.atomic(path.join(target,'upgrade.json'),{kind:'pm2-selection',phase:'prepared',pathsFile,previous,next:JSON.stringify(paths),selected});
    const helper=path.join(target,'activate-pm2.cjs');await fs.copyFile(path.join(__dirname,'service-upgrade-pm2.cjs'),helper);if(process.platform!=='win32'){await upgrade.run('chown',['manager-agent:manager-agent',path.join(target,'upgrade.json')]);await fs.chmod(helper,0o644);}
    await platform.asAgent(plan.agentRoot,helper,[plan.agentRoot,target]);
  }else{paths.ng=selected;const next=JSON.stringify(paths);await upgrade.atomic(path.join(target,'upgrade.json'),{kind:'tool-selection',phase:'activating',pathsFile,previous,next,selected});await upgrade.atomic(pathsFile,next);await upgrade.atomic(path.join(target,'upgrade.json'),{kind:'tool-selection',phase:'complete',pathsFile,previous,next,selected});}
  return {status:'success',operationId:plan.operationId,service:plan.service,mode:'update',version:plan.version,path:selected,backup:target,message:'Updated CLI verified. Existing installation and project-local dependencies preserved.'};
}
async function execute(plan,stage){
  policy.validate(plan.service,plan.currentVersion,plan.version,process.platform);if(plan.mode!=='update'||!/^[a-f0-9-]{36}$/.test(plan.operationId))throw Error('Invalid upgrade plan');
  const target=path.join(plan.dataRoot,'updates',plan.service,plan.operationId);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await upgrade.regular(path.dirname(target),true);
  const asset=plan.downloads.update;if(asset.version!==plan.version)throw Error('The update archive does not match the review');
  if(plan.service==='phpmyadmin')throw Error('Browser updates require service-account verification');
  await upgrade.regular(plan.service==='angular'?await fs.realpath(plan.path):plan.path);
  let executable=plan.path,context={};if(plan.service==='composer'){const paths=JSON.parse(await fs.readFile(path.join(plan.agentRoot,'tool-paths.json'),'utf8'));context.php=paths.php;if(!context.php)throw Error('Select the existing PHP executable before updating Composer');context.php=await fs.realpath(context.php);await upgrade.regular(context.php);if(/\.(bat|cmd)$/i.test(executable))executable=path.join(path.dirname(executable),'composer.phar');await upgrade.regular(executable);}
  const current=await binaryVersion(plan.service,executable,context);if(current!==plan.currentVersion)throw Error('The installed version changed after review');
  if(['pm2','angular'].includes(plan.service))return npmUpdate(plan,target);
  const source=await upgrade.unpack(asset,target),candidate=path.join(source,asset.executable);await upgrade.regular(candidate);if(await binaryVersion(plan.service,candidate,context)!==plan.version)throw Error('The staged binary did not report the selected version');
  const database=policy.services[plan.service].kind==='database';let installRoot=path.dirname(plan.path),replacements;
  if(database){installRoot=path.dirname(path.dirname(plan.path));replacements=[];for(const directory of asset.directories){const candidateRoot=path.join(source,directory);try{await fs.access(candidateRoot)}catch{continue}for(const file of await upgrade.files(candidateRoot))replacements.push({source:path.join(candidateRoot,file),destination:path.join(installRoot,directory,file)})}if(!replacements.length)throw Error('Empty database binary release');}
  else if(plan.service==='git'){installRoot=path.dirname(path.dirname(plan.path));replacements=(await upgrade.files(source)).map(file=>({source:path.join(source,file),destination:path.join(installRoot,file)}));}
  else replacements=[{source:candidate,destination:executable}];
  if(database&&!plan.serviceName)throw Error('A database upgrade must identify its existing service');
  if(plan.service==='caddy'){
    if(!plan.serviceName||!plan.configPath)throw Error('Select the existing Caddy service and configuration before updating it');
    const oldModules=(await upgrade.run(plan.path,['list-modules'])).split(/\r?\n/).filter(line=>/^[a-z][a-z0-9_.]+$/.test(line)),newModules=new Set((await upgrade.run(candidate,['list-modules'])).split(/\r?\n/));if(oldModules.some(name=>!newModules.has(name)))throw Error('The official binary does not contain all existing Caddy modules. Preserve the custom build.');
    await upgrade.run(candidate,['validate','--config',plan.configPath,...(path.extname(plan.configPath).toLowerCase()==='.json'?[]:['--adapter','caddyfile'])]);
  }
  const adapter=await adapterFor(plan,installRoot,stage),result=await upgrade.replaceFiles(target,replacements,async()=>{if(await binaryVersion(plan.service,executable,context)!==plan.version)throw Error('Updated executable version mismatch');await adapter.verify?.();},adapter);
  return {status:'success',operationId:plan.operationId,service:plan.service,mode:'update',version:plan.version,path:plan.path,...result,message:'Selected release verified. Existing service registration, configuration and database data preserved.'};
}
async function recover(plan,stage,action){
  const target=path.join(plan.dataRoot,'updates',plan.service,plan.operationId),journalFile=path.join(target,'upgrade.json');await upgrade.regular(target,true);
  if(plan.service==='phpmyadmin'){
    const check=async root=>{const script=path.join(target,'browser-check.cjs');await upgrade.regular(script);await platform.asAgent(plan.agentRoot,script,[root]);};
    if(action==='restore')return {...await upgrade.browserRecover(plan,target,check),operationId:plan.operationId,service:plan.service};
    if(action!=='verify')throw Error('Choose verification or restoration');
    const state=JSON.parse(await fs.readFile(journalFile,'utf8'));if(state.operationId!==plan.operationId||state.kind!=='browser'||await fs.readFile(state.marker,'utf8')!==JSON.stringify(state.config))throw Error('The selected browser release is not active');await check(plan.agentRoot);state.phase='complete';await upgrade.atomic(journalFile,state);return {status:'success',operationId:plan.operationId,service:plan.service,version:plan.version,message:'Updated private browser verified using its service account.'};
  }
  const journal=JSON.parse(await fs.readFile(journalFile,'utf8')),database=policy.services[plan.service].kind==='database';
  if(journal.kind==='pm2-selection'){
    await platform.asAgent(plan.agentRoot,path.join(target,'activate-pm2.cjs'),[plan.agentRoot,target,action]);return {status:action==='verify'?'success':'failed',operationId:plan.operationId,service:plan.service,message:action==='verify'?'Updated private PM2 daemon verified.':'Previous private PM2 daemon restored; applications and external process managers preserved.'};
  }
  if(journal.kind==='tool-selection'){
    const current=await fs.readFile(journal.pathsFile,'utf8');if(current!==journal.next&&current!==journal.previous)throw Error('Tool selection changed after the update; recovery is blocked');
    if(action==='verify'){if(current!==journal.next||await binaryVersion(plan.service,journal.selected)!==plan.version)throw Error('The new tool selection is not active');journal.phase='complete';}
    else if(action==='restore'){await upgrade.atomic(journal.pathsFile,journal.previous);journal.phase='rolled_back';}else throw Error('Choose verification or restoration');
    await upgrade.atomic(journalFile,journal);return {status:action==='verify'?'success':'failed',operationId:plan.operationId,service:plan.service,message:action==='verify'?'Updated tool verified.':'Previous tool selection restored; both installations retained.'};
  }
  if(plan.serviceName){const before=JSON.parse(await fs.readFile(path.join(target,'service-before.json'),'utf8')),actual=await platform.inspectSelected(plan);for(const key of ['command','account','startMode'])if(before[key]!==actual[key])throw Error('Service registration changed; recovery is blocked');if(!(await fs.readFile(plan.configPath)).equals(await fs.readFile(path.join(target,'configuration-before'))))throw Error('Service configuration changed; recovery is blocked');}
  const restored=journal.restored||journal.phase==='rolled_back',expected=restored?plan.currentVersion:plan.version;
  if(journal.dataRestore&&!restored&&action!=='restore')throw Error('Continue the interrupted backup restoration before starting this database');
  let executable=plan.path,context={};if(plan.service==='composer'){const paths=JSON.parse(await fs.readFile(path.join(plan.agentRoot,'tool-paths.json'),'utf8'));context.php=paths.php;if(/\.(bat|cmd)$/i.test(executable))executable=path.join(path.dirname(executable),'composer.phar');}
  const verify=async version=>{if(database)await platform.waitForDatabase(plan,stage,version);else if(await binaryVersion(plan.service,executable,context)!==version)throw Error('The installed version is not the selected release')};
  if(action==='verify'||restored){
    if(plan.serviceName)await platform.transitionSelected(plan,'start');try{await verify(expected);journal.phase=restored?'rolled_back':'complete';await upgrade.atomic(journalFile,journal);return{status:restored?'failed':'success',operationId:plan.operationId,service:plan.service,version:expected,message:restored?'Previous installation restored and verified; recovery files retained.':'Updated service verified; recovery files retained.'};}catch(error){if(plan.serviceName)await platform.transitionSelected(plan,'stop');throw error;}
  }
  if(action!=='restore')throw Error('Choose verification or reviewed backup restoration');
  if(plan.serviceName)await platform.transitionSelected(plan,'stop');
  if(database&&journal.started)await platform.restoreDatabase(plan,target,journal);
  await upgrade.restoreFiles(journalFile);try{if(plan.serviceName)await platform.transitionSelected(plan,'start');await verify(plan.currentVersion)}catch(error){if(plan.serviceName)await platform.transitionSelected(plan,'stop');throw error}
  return{status:'failed',operationId:plan.operationId,service:plan.service,message:'Previous installation restored and verified. Recovery files and post-upgrade data were retained.'};
}
module.exports={execute,recover,binaryVersion};
if(require.main===module)(async()=>{const file=process.argv[2],stage=path.dirname(file),plan=JSON.parse(await fs.readFile(file,'utf8'));try{const result=process.argv[3]?await recover(plan,stage,process.argv[3]):await execute(plan,stage);await upgrade.atomic(path.join(stage,'result.json'),result);}catch(error){const message=String(error.message).replaceAll(plan.databaseCredential?.password||randomUUID(),'[redacted]'),journal=await fs.readFile(path.join(plan.dataRoot,'updates',plan.service,plan.operationId,'upgrade.json'),'utf8').then(JSON.parse).catch(()=>null),interrupted=!!process.argv[3]||journal&&['needs_review','starting','replacing','activating'].includes(journal.phase);await upgrade.atomic(path.join(stage,'result.json'),{status:interrupted?'interrupted':'failed',operationId:plan.operationId,service:plan.service,message,preservedData:true});console.error(message);process.exitCode=1;}})();
