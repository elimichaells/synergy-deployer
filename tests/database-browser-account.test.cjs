'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const run=promisify(execFile),configure=require('../scripts/install-database-browser.cjs').configure;
test('private Windows CGI runs as Local Service without Manager credentials',{skip:process.platform!=='win32'||!process.env.TEST_DATABASE_BROWSER_ROOT,timeout:90000},async()=>{
  const fixture=path.resolve(process.env.TEST_DATABASE_BROWSER_ROOT);assert.match(path.basename(fixture),/^manager-browser-preview-[A-Za-z0-9]+$/);
  const original=JSON.parse(await fs.readFile(path.join(fixture,'database-browser.json'),'utf8'));
  const name='ManagerBrowserAccountLab-'+randomUUID(),root=path.join(process.env.ProgramData,name),ps=value=>"'"+value.replaceAll("'","''")+"'";
  await fs.mkdir(root);assert.equal(path.dirname(root),process.env.ProgramData);
  await fs.cp(original.clientRoot,path.join(root,'client'),{recursive:true});
  const config=await configure(root,original.phpCgi,original.version);await fs.writeFile(path.join(root,'database-browser.json'),JSON.stringify(config));
  await fs.copyFile(process.execPath,path.join(root,'node.exe'));await fs.copyFile(path.resolve('scripts/database-browser-agent.cjs'),path.join(root,'browser-check.cjs'));
  const output=path.join(root,'sessions','account-check.txt'),script=path.join(root,'account-check.ps1');
  await fs.writeFile(script,`$ErrorActionPreference='Continue'; & ${ps(path.join(root,'node.exe'))} ${ps(path.join(root,'browser-check.cjs'))} ${ps(root)} *> ${ps(output)}; [IO.File]::WriteAllText(${ps(output+'.exit')},[string]$LASTEXITCODE)`);
  const command=`$ErrorActionPreference='Stop'; & icacls.exe ${ps(root)} /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX' | Out-Null; if($LASTEXITCODE -ne 0){throw 'Private fixture permissions failed'}; foreach($folder in @('temp','sessions')){& icacls.exe (Join-Path ${ps(root)} $folder) /grant '*S-1-5-19:(OI)(CI)M' | Out-Null; if($LASTEXITCODE -ne 0){throw 'Private writable fixture permissions failed'}}; $a=New-ScheduledTaskAction -Execute "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Argument ${ps('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+script+'"')}; Register-ScheduledTask -TaskName ${ps(name)} -Action $a -Principal (New-ScheduledTaskPrincipal -UserId 'S-1-5-19' -LogonType ServiceAccount -RunLevel Limited) | Out-Null; try {Start-ScheduledTask -TaskName ${ps(name)}; for($i=0;$i -lt 30;$i++){if(Test-Path -LiteralPath ${ps(output+'.exit')}){break}; Start-Sleep -Seconds 1}} finally {Stop-ScheduledTask -TaskName ${ps(name)} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${ps(name)} -Confirm:$false}`;
  await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,timeout:60000});
  const result=(await fs.readFile(output+'.exit','utf8')).trim(),details=(await fs.readFile(output,'utf8')).replaceAll('\0','').slice(0,2000);
  assert.equal(result,'0','Private service-account CGI failed: '+details);
  // Keep the exact diagnostic folder for this run; it contains only fixture data.
});
