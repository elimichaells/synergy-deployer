import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const root='C:/ManagerAcceptanceLab',read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||process.env.MANAGER_INSTALL_LAB!=='1'||process.platform!=='win32')throw Error('Reboot is restricted to the disposable hosted Windows lab');
const identity=read(root+'/private/identity.json'),before=read(root+'/results/install-result.json');
if(identity.computer!==process.env.COMPUTERNAME||identity.runId!==process.env.GITHUB_RUN_ID||before.status!=='passed')throw Error('Disposable machine identity or successful install receipt missing');
const env={};for(const key of ['ACTIONS_RUNTIME_TOKEN','ACTIONS_RUNTIME_URL','ACTIONS_RESULTS_URL','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_JOB','GITHUB_REPOSITORY','GITHUB_WORKSPACE','GITHUB_SERVER_URL','GITHUB_API_URL'])if(process.env[key])env[key]=process.env[key];
if(!env.ACTIONS_RUNTIME_TOKEN||!env.ACTIONS_RESULTS_URL)throw Error('Independent receipt upload credentials are unavailable');
fs.writeFileSync(root+'/private/artifact-environment.json',JSON.stringify(env));
// Keep the verifier and its dependencies on the OS disk, independent of the
// runner workspace and temporary disk initialization after boot.
const verifier=root+'/private/verifier';fs.cpSync(path.join(identity.workspace,'tests/install-lab'),verifier,{recursive:true});
const script=verifier+'/postboot.mjs',node=root+'/private/verifier-node.exe';fs.copyFileSync(process.execPath,node);
const q=s=>"'"+s.replaceAll("'","''")+"'";
const probeCode=`$ErrorActionPreference='Stop';$action=New-ScheduledTaskAction -Execute ${q(node)} -Argument ${q('"'+script+'" probe')};$principal=New-ScheduledTaskPrincipal -UserId SYSTEM -LogonType ServiceAccount -RunLevel Highest;Register-ScheduledTask -TaskName 'Manager Reboot Upload Probe' -Action $action -Principal $principal -Force | Out-Null;Start-ScheduledTask -TaskName 'Manager Reboot Upload Probe';`;
execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(probeCode,'utf16le').toString('base64')],{stdio:'inherit',windowsHide:true});
const probeDeadline=Date.now()+120000;
while(!fs.existsSync(root+'/private/probe-success.json')&&Date.now()<probeDeadline)await new Promise(r=>setTimeout(r,1000));
if(!fs.existsSync(root+'/private/probe-success.json'))throw Error('SYSTEM upload probe failed before reboot: '+(fs.existsSync(root+'/private/upload-error.txt')?fs.readFileSync(root+'/private/upload-error.txt','utf8'):'no success receipt'));
const probe=read(root+'/private/probe-success.json');if(probe.status!=='ready'||probe.user!=='S-1-5-18'||probe.runId!==identity.runId)throw Error('Independent SYSTEM verifier identity check failed');
console.log('SYSTEM verifier successfully uploaded its pre-reboot proof.');
// Rehearse the installed recovery task while this runner can still collect logs.
// This is separate evidence and must never stand in for a real OS reboot receipt.
const recovery=`$ErrorActionPreference='Stop';$env:PM2_HOME='C:\\ProgramData\\Manager\\pm2';$config=Get-Content -LiteralPath 'C:\\ProgramData\\Manager\\pm2-startup.json' -Raw|ConvertFrom-Json;$env:Path=(Split-Path -Parent $config.node)+';'+(Split-Path -Parent $config.pm2)+';'+$config.path;& $config.pm2 kill;if($LASTEXITCODE){throw 'Could not stop the disposable Manager processes'};$requested=(Get-Date).AddSeconds(-2);Start-ScheduledTask -TaskName 'Manager PM2 Startup';$deadline=(Get-Date).AddSeconds(90);$complete=$false;while((Get-Date)-lt $deadline){$task=Get-ScheduledTask -TaskName 'Manager PM2 Startup';$info=$task|Get-ScheduledTaskInfo;if($info.LastRunTime-ge $requested-and $task.State-eq 'Ready'){if($info.LastTaskResult-ne 0){throw ('SYSTEM recovery task failed: '+$info.LastTaskResult)};$complete=$true;break};Start-Sleep -Seconds 1};if(!$complete){throw 'SYSTEM recovery task did not complete'};`;
execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(recovery,'utf16le').toString('base64')],{stdio:'inherit',windowsHide:true,timeout:120000});
await createRequire(import.meta.url)('./verify.cjs').verify('system-recovery');
const {DefaultArtifactClient}=await import('@actions/artifact');
await new DefaultArtifactClient().uploadArtifact('manager-system-recovery',[root+'/results/system-recovery.json'],root+'/results',{retentionDays:7});
if(process.env.MANAGER_LAB_REBOOT!=='1'){
  fs.unlinkSync(root+'/private/artifact-environment.json');
  console.log('Fresh installation and installed SYSTEM recovery task passed. An OS reboot was not requested or verified.');
  process.exit(0);
}
const code=`$ErrorActionPreference='Stop';$action=New-ScheduledTaskAction -Execute ${q(node)} -Argument ${q('"'+script+'"')};$trigger=New-ScheduledTaskTrigger -AtStartup;$trigger.Delay='PT30S';$principal=New-ScheduledTaskPrincipal -UserId SYSTEM -LogonType ServiceAccount -RunLevel Highest;$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10);Register-ScheduledTask -TaskName 'Manager Isolated Reboot Verification' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null;`;
execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{stdio:'inherit',windowsHide:true});
console.log('Independent startup verifier registered. Rebooting only this disposable GitHub-hosted VM.');
execFileSync('shutdown.exe',['/r','/t','10','/f','/c','Isolated Manager acceptance lab: verify real automatic boot recovery'],{stdio:'inherit',windowsHide:true});
await new Promise(resolve=>setTimeout(resolve,15*60*1000));
throw Error('Expected OS reboot did not terminate the runner');
