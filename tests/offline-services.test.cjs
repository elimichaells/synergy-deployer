const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const quote=v=>"'"+v.replaceAll("'","''")+"'";
function ps(code){return execFileSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-OutputFormat','Text','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+$env:PSModulePath; . "+quote(path.resolve(__dirname,'../scripts/offline-service.ps1'))+'\n'+code,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:30000,stdio:['ignore','pipe','pipe']});}
function cleanup(root){if(!path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'manager-offline-service-'))throw Error('Unsafe cleanup');fs.rmSync(root,{recursive:true,force:true});}
test('offline package verification rejects missing, corrupted and escaped artifacts before changes',{skip:process.platform!=='win32'},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'manager-offline-service-package-'));
 try{
  const bytes=Buffer.from('fixture archive'),artifact={id:'mysql',version:'1',file:'mysql.zip',bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  fs.writeFileSync(path.join(root,'mysql.zip'),bytes);
  const save=()=>fs.writeFileSync(path.join(root,'services.json'),JSON.stringify({schemaVersion:1,architecture:'win-x64',minimumWindowsBuild:17763,artifacts:[artifact]}));save();
  assert.match(ps(`(Read-ServicePackage ${quote(root)} 'mysql').Item.version`),/1/);
  fs.writeFileSync(path.join(root,'mysql.zip'),'changed');assert.throws(()=>ps(`Read-ServicePackage ${quote(root)} 'mysql'`),/Command failed/);
  artifact.file='../outside.exe';save();assert.throws(()=>ps(`Read-ServicePackage ${quote(root)} 'mysql'`));
  artifact.file='mysql.zip';save();fs.unlinkSync(path.join(root,'mysql.zip'));assert.throws(()=>ps(`Read-ServicePackage ${quote(root)} 'mysql'`));
 }finally{cleanup(root)}
});
test('machine-protected service credential is stable across fresh processes and is not plaintext',{skip:process.platform!=='win32'},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'manager-offline-service-secret-'));
 try{
  const result=ps(`Protect-ServiceDirectory ${quote(root)}; $secret=New-ServiceCredential ${quote(root)} 'manager_project_admin'; $digest=[Security.Cryptography.SHA256]::Create(); [BitConverter]::ToString($digest.ComputeHash([Text.Encoding]::UTF8.GetBytes($secret.password)))`).trim();
  const second=ps(`$secret=Read-ServiceCredential ${quote(root)}; $digest=[Security.Cryptography.SHA256]::Create(); [BitConverter]::ToString($digest.ComputeHash([Text.Encoding]::UTF8.GetBytes($secret.password)))`).trim();
  assert.equal(result,second);assert.ok(!fs.readFileSync(path.join(root,'credential.dpapi'),'utf8').includes('manager_project_admin'));
 }finally{cleanup(root)}
});
test('service verification requires the intended binary, automatic startup and loopback listener',{skip:process.platform!=='win32'},()=>{
 const result=ps(`
 function Get-CimInstance {param($Class,$Filter); if($Class -eq 'Win32_Process'){return}; @{State=$script:state;StartMode=$script:mode;ProcessId=77;PathName=$script:binary}}
 function Get-NetTCPConnection {param($State,$ErrorAction); [pscustomobject]@{OwningProcess=77;LocalPort=$script:port;LocalAddress=$script:address}}
 $receipt=@{service='Fixture';executable='C:\\fixture\\mysqld.exe';port=3306}
 foreach($case in @('good','manual','stopped','foreign','exposed','wrongport')) {
   $script:state='Running';$script:mode='Auto';$script:binary='"C:\\fixture\\mysqld.exe" --defaults-file=config';$script:port=3306;$script:address='127.0.0.1'
   switch($case){'manual'{$script:mode='Manual'} 'stopped'{$script:state='Stopped'} 'foreign'{$script:binary='C:\\other\\mysqld.exe'} 'exposed'{$script:address='0.0.0.0'} 'wrongport'{$script:port=3307}}
   $failed=$false;try{Assert-OfflineServiceHealth $receipt}catch{$failed=$true}
   if($failed -eq ($case -eq 'good')){throw ('Unexpected result '+$case)}
   'PASS '+$case
 }
 `);for(const name of ['good','manual','stopped','foreign','exposed','wrongport'])assert.ok(result.includes('PASS '+name));
});
test('SQL Server TCP configuration disables public interfaces and dynamic ports',{skip:process.platform!=='win32'},()=>{
 const result=ps(`
 function Test-Path {param($LiteralPath);$true}
 function Get-ChildItem {param($LiteralPath); @([pscustomobject]@{PSChildName='IP1';PSPath='fixture-loopback'},[pscustomobject]@{PSChildName='IP2';PSPath='fixture-public'},[pscustomobject]@{PSChildName='IPAll';PSPath='fixture-all'})}
 function Get-ItemProperty {param($LiteralPath);@{IpAddress=$(if($LiteralPath -eq 'fixture-loopback'){'127.0.0.1'}else{'192.168.64.90'})}}
 $script:changes=@{}
 function Set-ItemProperty {param($LiteralPath,$Name,$Value);$script:changes[$LiteralPath+'|'+$Name]=$Value}
 Enable-OfflineSqlTcp 'MSSQL16.MANAGER' 1433
 if($changes['fixture-loopback|Enabled'] -ne 1 -or $changes['fixture-public|Enabled'] -ne 0 -or $changes['fixture-loopback|TcpPort'] -ne '1433' -or $changes['fixture-loopback|TcpDynamicPorts'] -ne ''){throw 'Incorrect SQL binding'}
 if(@($changes.Keys|Where-Object {$_ -like '*|ListenOnAllIPs' -and $changes[$_] -eq 0}).Count -ne 1){throw 'ListenOnAllIPs was not disabled'}
 function Get-ItemProperty {param($LiteralPath);@{IpAddress='192.168.64.90'}}
 $failed=$false;try{Enable-OfflineSqlTcp 'MSSQL16.MANAGER' 1433}catch{$failed=$true};if(-not $failed){throw 'Missing loopback was accepted'}
 'PASS'
 `);assert.match(result,/PASS/);
});

test('SQL offline setup applies its local security update only to MANAGER before enabling TCP',{skip:process.platform!=='win32'},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'manager-offline-service-sql-'));
 try{const result=ps(`
 function Read-ServicePackage {param($BundleRoot,$Id);@{Item=@{sha256=('a'*64);version=$(if($Id -eq 'sqlserver-update'){'16.0.1210.3'}else{'2022'})};File=$Id}}
 function Get-CimInstance {param($Class,$Filter); if($script:registered -and $Class -eq 'Win32_Service'){@{State='Running';StartMode='Auto';ProcessId=77;PathName=('"'+$script:executable+'"')}}}
 function Get-NetTCPConnection {param($State,$LocalPort,$ErrorAction)}
 function Invoke-ManagerOfflineSetup {param($File,$Arguments,$SuccessCodes)
  if($File -eq 'sqlserver-update'){
   if($Arguments -notcontains '/InstanceName=MANAGER' -or $Arguments -contains '/AllInstances'){throw 'Wrong patch scope'}
   if($script:scenario -eq 'patch-failure'){throw 'Fixture patch failed'}
   $script:patched=$true
  }elseif($File -like '*setup.exe'){
   $text=Get-Content -LiteralPath (Join-Path $script:state 'sql-setup.ini') -Raw
   if(-not $text.Contains('UPDATEENABLED="False"') -or -not $text.Contains('TCPENABLED="0"')){throw 'Setup attempted network/update discovery'}
   $script:registered=$true
  }
 }
 function Enable-OfflineSqlTcp {param($InstanceId,$Port);if(-not $script:patched){throw 'TCP enabled before patch'};$script:tcp=$true}
 function Set-Service {param($Name,$StartupType)}
 function Start-Service {param($Name)}
 function Restart-Service {param($Name)}
 function Stop-Service {param($Name,$ErrorAction);$script:stopped=$true}
 function Wait-OfflineServiceHealth {param($Receipt);if(-not $script:tcp){throw 'TCP missing'}}
 function Invoke-ServiceProbe {param($Context,$Mode);$r=Get-Content -LiteralPath (Join-Path $Context.StateRoot 'service.json') -Raw|ConvertFrom-Json;if($r.sqlVersion -ne '16.0.1210.3'){throw 'Patch receipt missing'}}
 foreach($case in @('success','patch-failure')){
  $script:scenario=$case;$script:registered=$false;$script:patched=$false;$script:tcp=$false;$script:stopped=$false
  $script:state=Join-Path ${quote(root)} $case;$script:executable=Join-Path $state 'runtime/MSSQL16.MANAGER/MSSQL/Binn/sqlservr.exe'
  $failed=$false;try{Install-OfflineDatabase @{Engine='sqlserver';Bundle='fixture';StateRoot=$state}}catch{if($case -eq 'success'){throw};$failed=$true}
  $r=Get-Content -LiteralPath (Join-Path $state 'service.json') -Raw|ConvertFrom-Json
  if($case -eq 'success' -and ($failed -or $r.phase -ne 'ready')){throw 'Patched setup failed'}
  if($case -eq 'patch-failure' -and (-not $failed -or $r.phase -eq 'ready' -or -not $stopped -or $tcp)){throw 'Unpatched service accepted'}
  if(Test-Path -LiteralPath (Join-Path $state 'sql-setup.ini')){throw 'Plaintext setup credential retained'}
  'PASS '+$case
 }
 `);assert.match(result,/PASS success/);assert.match(result,/PASS patch-failure/);}finally{cleanup(root)}
});

test('conflicting services, occupied ports and existing data are rejected before installer execution',{skip:process.platform!=='win32'},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'manager-offline-service-conflict-'));
 try{const result=ps(`
 function Read-ServicePackage {param($BundleRoot,$Id); @{Item=@{sha256=('a'*64);version='1'};File='fixture.zip'}}
 function Get-CimInstance {param($Class,$Filter); if($script:case -eq 'service'){@{ProcessId=77;PathName='C:\\existing\\mysqld.exe'}}}
 function Get-NetTCPConnection {param($State,$LocalPort,$ErrorAction); if($script:case -eq 'port'){@{OwningProcess=88}}}
 function Invoke-ManagerOfflineSetup {throw 'INSTALLER EXECUTED'}
 foreach($case in @('service','port','data')){
   $script:case=$case;$state=Join-Path ${quote(root)} $case
   if($case -eq 'data'){New-Item -ItemType Directory -Path $state | Out-Null;Set-Content -LiteralPath (Join-Path $state 'precious.txt') -Value 'keep'}
   $failed=$false;try{Install-OfflineDatabase @{Engine='mysql';Bundle='fixture';StateRoot=$state}}catch{if($_.Exception.Message -match 'INSTALLER EXECUTED'){throw};$failed=$true}
   if(-not $failed){throw 'Conflict accepted'}
   if($case -eq 'data' -and (Get-Content -LiteralPath (Join-Path $state 'precious.txt')) -ne 'keep'){throw 'Data changed'}
   'PASS '+$case
 }
 `);for(const name of ['service','port','data'])assert.ok(result.includes('PASS '+name));}finally{cleanup(root)}
});
