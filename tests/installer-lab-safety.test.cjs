const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const exec=promisify(execFile),env={...process.env,GITHUB_ACTIONS:'false',RUNNER_ENVIRONMENT:'local',MANAGER_INSTALL_LAB:'1'};
test('fresh-install lab refuses a non-disposable host before any provisioning',{skip:process.platform!=='win32'},async()=>{
  await assert.rejects(exec('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve(__dirname,'install-lab/install.ps1'),'-Release','2.30.4'],{env,windowsHide:true,timeout:15000}),error=>/restricted to a disposable GitHub-hosted Windows VM/.test(error.stderr));
});
test('reboot lab refuses local execution before reading credentials or scheduling a reboot',async()=>{
  await assert.rejects(exec(process.execPath,[path.resolve(__dirname,'install-lab/reboot-action.mjs')],{env,windowsHide:true,timeout:15000}),error=>/Reboot is restricted to the disposable hosted Windows lab/.test(error.stderr));
});
for(const script of ['prepare.ps1','restart-failure.ps1'])test(script+' refuses database lab operations on production',{skip:process.platform!=='win32'},async()=>{
  const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve(__dirname,'database-lab',script)];
  if(script==='restart-failure.ps1')args.push('-Engine','mysql','-ServiceName','ManagerLabMySQLTarget');
  await assert.rejects(exec('powershell.exe',args,{env:{...env,MANAGER_DATABASE_LAB:'1'},windowsHide:true,timeout:15000}),error=>/disposable/.test(error.stderr));
});
