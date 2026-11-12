'use strict';
// Executed as the agent account, using only its guarded private PM2 daemon.
const fs=require('node:fs/promises'),path=require('node:path');
async function control(root,action,expected){
  const agent=require(path.join(root,'manager-agent.cjs'));
  if(await agent.sharedProxySettings(root))throw Error('This agent shares an existing proxy. Select its native service for reviewed maintenance.');
  const paths=JSON.parse(await fs.readFile(path.join(root,'tool-paths.json'),'utf8'));
  const environment=await agent.privatePm2Environment(root,paths.pm2);
  const pm=args=>agent.run(paths.node,[paths.pm2,...args],{env:environment,timeout:90000});
  const list=async()=>{const text=await pm(['jlist']);for(const line of text.split(/\r?\n/).reverse()){try{const value=JSON.parse(line);if(Array.isArray(value))return value}catch{}}throw Error('Invalid private process inventory')};
  const inspect=async()=>{
    const matches=(await list()).filter(p=>p.name==='manager-remote-caddy');if(matches.length!==1)throw Error('No unique agent-managed Caddy process was found');
    const item=matches[0],env=item.pm2_env,args=env.args||[],at=args.indexOf('--config');
    if(await fs.realpath(env.pm_exec_path)!==await fs.realpath(expected.path)||at<0||path.resolve(args[at+1])!==path.resolve(expected.configPath))throw Error('The private Caddy process does not match this installation and configuration');
    const identity={id:item.pm_id,name:item.name,executable:env.pm_exec_path,args,cwd:env.pm_cwd,interpreter:env.exec_interpreter,mode:env.exec_mode};
    if(expected.identity&&JSON.stringify(identity)!==JSON.stringify(expected.identity))throw Error('The private Caddy process definition changed');
    return {identity,pid:item.pid,status:env.status==='online'?'Running':env.status};
  };
  const initial=await inspect();
  if(action==='inspect')return initial;
  if(!['start','stop'].includes(action))throw Error('Unsupported private proxy maintenance action');
  await pm([action==='start'?'restart':'stop',String(initial.identity.id)]);await pm(['save','--force']);
  for(let attempt=0;attempt<30;attempt++){const actual=await inspect();if(action==='stop'&&actual.status==='stopped')return actual;if(action==='start'&&actual.status==='Running'&&actual.pid){await new Promise(resolve=>setTimeout(resolve,1500));const stable=await inspect();if(stable.pid===actual.pid&&stable.status==='Running')return stable}await new Promise(resolve=>setTimeout(resolve,300));}
  throw Error('The private Caddy process did not reach the requested state');
}
module.exports={control};
if(require.main===module)control(process.argv[2],process.argv[3],JSON.parse(process.argv[4])).then(value=>console.log('MANAGER_CADDY_RESULT='+JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1});
