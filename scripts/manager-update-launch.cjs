// Windows updates must outlive PM2 stopping the Manager process and its children.
const path=require('node:path');
const cp=require('node:child_process');
function startWorker(c,{platform=process.platform,spawn=cp.spawn}={}) {
  if(platform==='win32') {
    // Never start the worker inside Manager's process tree. The registered
    // minute/startup trigger also picks up queued work if this wake-up fails.
    if(typeof c.recoveryTask!=='string'||!/^Manager Update Recovery [A-F0-9]{12}$/.test(c.recoveryTask))return;
    try {
      const child=spawn('schtasks.exe',['/Run','/TN',c.recoveryTask],{cwd:c.stateRoot,windowsHide:true,stdio:'ignore'});
      child.on('error',()=>{});child.unref();
    }catch { /* The independent scheduled trigger remains available. */ }
    return;
  }
  const worker=path.join(c.stateRoot,'runner/manager-update-worker.cjs');
  const child=spawn(c.nodeExe,[worker,path.join(c.managerRoot,'.manager-updater.json'),'run'],{cwd:c.stateRoot,detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,MANAGER_PREVIEW:'0'}});
  child.on('error',()=>{});child.unref();
}
module.exports={startWorker};
