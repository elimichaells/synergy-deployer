const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const quote=v=>"'"+v.replaceAll("'","''")+"'";
test('offline upgrade replaces application files, retains secrets and restores old files on failed health/save', {skip:process.platform!=='win32'},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'manager-upgrade-test-'));
 try{
 const script=`
 $ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+$env:PSModulePath
 $PSScriptRoot=${quote(path.resolve(__dirname,'../scripts'))}
 $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(${quote(path.resolve(__dirname,'../scripts/upgrade-manager-offline.ps1'))},[ref]$tokens,[ref]$errors)
 if($errors.Count){throw 'PowerShell parse failed'}
 $move=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Move-UpgradeItem'},$true)
 Invoke-Expression $move.Extent.Text
 $statements=@($ast.EndBlock.Statements);$start=0
 while($start -lt $statements.Count -and -not $statements[$start].Extent.Text.StartsWith('$recovery=')){$start++}
 if($start -eq $statements.Count){throw 'Upgrade body missing'}
 $body=Join-Path ${quote(root)} 'simulate.ps1'
 Set-Content -LiteralPath $body -Value (($statements[$start..($statements.Count-1)]|ForEach-Object {$_.Extent.Text}) -join "\n")
 function Invoke-CaddyRepairNative {param($File,$Arguments)
  if($File -eq 'pm2.cmd'){
   $global:events.Add($Arguments[0]+'-'+$Arguments[1])
   if($Arguments[0] -eq 'save' -and $global:scenario -eq 'save'){throw 'Save failed'}
  }
  if($File -eq 'node.exe' -and $global:scenario -eq 'health'){throw 'Health failed'}
 }
 function Expand-ManagerOfflineArchive {param($Archive,$Destination);New-Item -ItemType Directory -Path (Join-Path $Destination '.next'),(Join-Path $Destination 'node_modules')|Out-Null;Set-Content -LiteralPath (Join-Path $Destination '.next/BUILD_ID') -Value 'new'}
 function Get-ManagerOfflinePath {param($Root,$Relative);'fixture.zip'}
 function Save-ManagerOfflineServiceBundle {param($Bundle,$Destination);$global:events.Add('bundle')}
 function Start-Sleep {param($Seconds)}
 foreach($scenario in @('success','health','save')){
  $global:scenario=$scenario;$global:events=[Collections.Generic.List[string]]::new()
  $dataRoot=Join-Path ${quote(root)} $scenario;$target=Join-Path $dataRoot 'manager';$packageRoot=Join-Path $dataRoot 'package'
  New-Item -ItemType Directory -Path (Join-Path $dataRoot 'pm2'),(Join-Path $target '.next'),(Join-Path $target 'node_modules'),(Join-Path $target 'scripts'),$packageRoot -Force|Out-Null
  Set-Content -LiteralPath (Join-Path $target '.env.local') -Value 'preserved-secret'
  Set-Content -LiteralPath (Join-Path $target '.next/BUILD_ID') -Value 'old'
  Set-Content -LiteralPath (Join-Path $target 'scripts/old.txt') -Value 'old script'
  Set-Content -LiteralPath (Join-Path $dataRoot 'pm2/dump.pm2') -Value 'old dump'
  Set-Content -LiteralPath (Join-Path $target 'package.json') -Value 'old package'
  Set-Content -LiteralPath (Join-Path $packageRoot 'package.json') -Value 'new package'
  $boot=@{pm2='pm2.cmd';node='node.exe'};$inspection=@{phpMyAdminRunning=$true};$bundle=@{Root='fixture';Items=@{application=@{file='fixture.zip'}}};$version='fixture'
  $failed=$false;try{& $body}catch{if($scenario -eq 'success'){throw};$failed=$true}
  if($failed -ne ($scenario -ne 'success')){throw ('Unexpected outcome '+$scenario)}
  $expected=if($failed){'old'}else{'new'}
  if((Get-Content -LiteralPath (Join-Path $target '.next/BUILD_ID')) -ne $expected){throw 'Wrong application survived'}
  if((Get-Content -LiteralPath (Join-Path $target '.env.local')) -ne 'preserved-secret'){throw 'Secret changed'}
  if($failed -and -not(Test-Path -LiteralPath (Join-Path $target 'scripts/old.txt'))){throw 'Scripts were not restored'}
  if(@($events|Where-Object {$_ -match '(stop|restart)-' -and $_ -notin @('stop-manager','stop-manager-phpmyadmin','restart-manager','restart-manager-phpmyadmin')}).Count){throw 'Unrelated process changed'}
  'PASS '+$scenario
 }
 $escaped=$false;try{Move-UpgradeItem $target $packageRoot '../escape'}catch{$escaped=$true};if(-not $escaped){throw 'Unsafe move allowed'}
 `;
 let result;try{result=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-OutputFormat','Text','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:30000,stdio:['ignore','pipe','pipe']})}catch(error){throw Error(error.stderr||error.message)}
 for(const scenario of ['success','health','save'])assert.match(result,new RegExp('PASS '+scenario));
 }finally{if(!path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'manager-upgrade-test-'))throw Error('Unsafe cleanup');fs.rmSync(root,{recursive:true,force:true})}
});
