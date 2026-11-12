'use strict';
// Run only as the agent service account. Its private socket guard prevents any
// connection to the Manager host's daemon or an institution's existing daemon.
const fs=require('node:fs/promises'),path=require('node:path');
async function atomicText(file,text){const temporary=file+'.'+require('node:crypto').randomUUID()+'.tmp';await fs.writeFile(temporary,text,{flag:'wx',mode:0o600});await fs.rename(temporary,file);}
function processList(output){for(const line of output.split(/\r?\n/).reverse()){try{const value=JSON.parse(line);if(Array.isArray(value))return value}catch{}}throw Error('The private PM2 daemon returned an invalid process inventory');}
async function switchDaemon(root,target,action='update'){
  const agent=require(path.join(root,'manager-agent.cjs')),journalFile=path.join(target,'upgrade.json'),journal=JSON.parse(await fs.readFile(journalFile,'utf8')),pathsFile=path.join(root,'tool-paths.json'),current=await fs.readFile(pathsFile,'utf8');
  if(journal.kind!=='pm2-selection'||journal.pathsFile!==pathsFile||![journal.previous,journal.next].includes(current)||!['update','verify','restore'].includes(action))throw Error('PM2 selection changed before activation');
  const previous=JSON.parse(journal.previous),next=JSON.parse(journal.next);
  const command=async(pm2,args)=>agent.run(previous.node,[pm2,...args],{env:await agent.privatePm2Environment(root,pm2),timeout:120000});
  const identity=items=>items.map(p=>({id:p.pm_id,name:p.name,script:p.pm2_env.pm_exec_path,status:p.pm2_env.status})).sort((a,b)=>a.id-b.id),snapshot=path.join(target,'pm2-before.json');
  let saved;if(action==='update'){if(current!==journal.previous||journal.phase!=='prepared')throw Error('PM2 update has already started');saved=identity(processList(await command(previous.pm2,['jlist'])));await command(previous.pm2,['save','--force']);await fs.writeFile(snapshot,JSON.stringify(saved),{flag:'wx',mode:0o600});journal.phase='activating';await agent.atomicJson(journalFile,journal);}else saved=JSON.parse(await fs.readFile(snapshot,'utf8'));
  const verify=async(pm2)=>{let active=processList(await command(pm2,['jlist']));for(const before of saved){const after=active.find(p=>p.pm_id===before.id);if(before.status==='stopped'&&after?.pm2_env.status==='online')await command(pm2,['stop',String(before.id)]);}for(let attempt=0;attempt<30;attempt++){active=processList(await command(pm2,['jlist']));if(JSON.stringify(identity(active))===JSON.stringify(saved))return;await new Promise(resolve=>setTimeout(resolve,500))}throw Error('Private PM2 application identity or status changed');};
  if(action==='restore'){await command(previous.pm2,['update']);await verify(previous.pm2);await atomicText(pathsFile,journal.previous);journal.phase='rolled_back';await agent.atomicJson(journalFile,journal);return;}
  if(action==='verify'){if(current!==journal.next)throw Error('The new PM2 selection is not active');await verify(next.pm2);journal.phase='complete';await agent.atomicJson(journalFile,journal);return;}
  try{await command(next.pm2,['update']);await verify(next.pm2);await atomicText(pathsFile,journal.next);journal.phase='complete';await agent.atomicJson(journalFile,journal);}
  catch(error){await command(previous.pm2,['update']);await verify(previous.pm2);await atomicText(pathsFile,journal.previous);journal.phase='rolled_back';await agent.atomicJson(journalFile,journal);throw error;}
}
module.exports={switchDaemon,processList};
if(require.main===module)switchDaemon(process.argv[2],process.argv[3],process.argv[4]||'update').catch(error=>{console.error(error.message);process.exitCode=1});
