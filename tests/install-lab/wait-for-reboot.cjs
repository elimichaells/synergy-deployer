const run=`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
async function query(path){const r=await fetch(run+path,{headers:{Authorization:'Bearer '+process.env.GH_TOKEN,Accept:'application/vnd.github+json','User-Agent':'manager-isolated-lab'},signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Lab query HTTP '+r.status);return r.json();}
(async()=>{const end=Date.now()+55*60*1000;while(Date.now()<end){
  if((await query('/artifacts')).artifacts.some(a=>a.name==='manager-install-after-reboot'&&!a.expired)){console.log('Independent post-reboot receipt received');return}
  const install=(await query('/jobs')).jobs.find(j=>j.name==='install');
  if(install?.status==='completed'&&install.steps?.some(s=>s.name==='Install published package on a disposable Windows machine'&&s.conclusion==='failure'))throw Error('Fresh installation failed before reboot; inspect the sanitized installation artifact');
  await new Promise(resolve=>setTimeout(resolve,30000));
}throw Error('No post-reboot receipt; an OS reboot and successful automatic recovery have NOT been proven');})().catch(e=>{console.error(e.message);process.exitCode=1});
