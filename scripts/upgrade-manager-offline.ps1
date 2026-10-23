[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+$env:PSModulePath
. (Join-Path $PSScriptRoot 'installer-offline.ps1')
function Invoke-CaddyRepairNative([string]$File,[string[]]$Arguments) {
 $output=& $File @Arguments
 if($LASTEXITCODE -ne 0){throw ([IO.Path]::GetFileName($File)+' failed with exit code '+$LASTEXITCODE)}
 return $output
}
function Move-UpgradeItem([string]$FromRoot,[string]$ToRoot,[string]$Name) {
 $from=[IO.Path]::GetFullPath((Join-Path $FromRoot $Name))
 $to=[IO.Path]::GetFullPath((Join-Path $ToRoot $Name))
 foreach($pair in @(@($from,$FromRoot),@($to,$ToRoot))){
  if(-not $pair[0].StartsWith([IO.Path]::GetFullPath($pair[1]).TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Upgrade path escaped its intended directory'}
 }
 Move-Item -LiteralPath $from -Destination $to
}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {throw 'Run this upgrade from administrator PowerShell'}
$packageRoot=Split-Path -Parent $PSScriptRoot
$dataRoot=Join-Path $env:ProgramData 'Manager'
$boot=Get-Content -LiteralPath (Join-Path $dataRoot 'pm2-startup.json') -Raw | ConvertFrom-Json
$report=Get-Content -LiteralPath (Join-Path $dataRoot 'install-report.json') -Raw | ConvertFrom-Json
$target=[IO.Path]::GetFullPath($report.managerRoot).TrimEnd('\')
if ($target -eq [IO.Path]::GetPathRoot($target).TrimEnd('\') -or $target -eq [IO.Path]::GetFullPath($packageRoot).TrimEnd('\')) {throw 'Extract this upgrade outside the installed Manager directory'}
$version=(Get-Content -LiteralPath (Join-Path $packageRoot 'package.json') -Raw | ConvertFrom-Json).version
$bundle=Read-ManagerOfflineBundle (Join-Path $packageRoot 'offline') $version ((Get-FileHash -LiteralPath (Join-Path $packageRoot 'package-lock.json')).Hash) @() @() $false
$release=Get-Content -LiteralPath (Join-Path $packageRoot 'release-source.json') -Raw | ConvertFrom-Json
if ($bundle.Manifest.sourceCommit -ne $release.sourceCommit) {throw 'Package source receipt does not match its offline build'}
$env:PM2_HOME=Join-Path $dataRoot 'pm2'
$env:Path=(Split-Path -Parent $boot.node)+';'+(Split-Path -Parent $boot.pm2)+';'+$boot.path
$inspection=(Invoke-CaddyRepairNative $boot.node @((Join-Path $PSScriptRoot 'offline-upgrade-check.cjs'),$dataRoot)) -join "`n" | ConvertFrom-Json
if ($inspection.version -notmatch '^2\.(19|20)\.') {throw 'This upgrade supports Manager 2.19.x and 2.20.x installations'}
$task=Get-ScheduledTask -TaskName 'Manager PM2 Startup'
if ($task.State -eq 'Disabled') {throw 'Enable the Manager PM2 Startup task before upgrading'}
$null=Invoke-CaddyRepairNative $boot.node @((Join-Path $PSScriptRoot 'caddy-repair-check.cjs'),'https',$dataRoot)
if(([IO.DriveInfo]::new([IO.Path]::GetPathRoot($dataRoot))).AvailableFreeSpace -lt 8GB){throw 'The Manager data drive needs at least 8 GB free for upgrade staging and recovery, plus space for optional databases'}
Write-Host ('Verified offline upgrade '+$inspection.version+' -> '+$version+' at '+$target)
if (-not $Apply) {Write-Host 'No changes made. Run again with -Apply to install the verified upgrade.';exit 0}
$recovery=Join-Path $dataRoot ('Recovery\upgrade-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $recovery | Out-Null
$null=Invoke-CaddyRepairNative 'icacls.exe' @($recovery,'/inheritance:r','/grant:r','*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F')
$stage=Join-Path $recovery 'stage';$previous=Join-Path $recovery 'previous'
New-Item -ItemType Directory -Path $stage,$previous | Out-Null
Expand-ManagerOfflineArchive (Get-ManagerOfflinePath $bundle.Root $bundle.Items['application'].file) $stage
$names=@('.next','node_modules','scripts','public','db','app','components','lib','types','package.json','package-lock.json','next.config.js','tsconfig.json','next-env.d.ts','instrumentation.ts','middleware.ts','release-source.json')
foreach($name in $names | Where-Object {$_ -notin @('.next','node_modules')}){
 $source=Join-Path $packageRoot $name
 if(Test-Path -LiteralPath $source){Copy-Item -LiteralPath $source -Destination (Join-Path $stage $name) -Recurse}
}
if(-not(Test-Path -LiteralPath (Join-Path $stage '.next\BUILD_ID'))){throw 'Production application is missing'}
Copy-Item -LiteralPath (Join-Path $target '.env.local') -Destination (Join-Path $recovery 'env.local.backup')
Copy-Item -LiteralPath (Join-Path $dataRoot 'pm2\dump.pm2') -Destination (Join-Path $recovery 'dump.pm2')
$oldNames=[Collections.Generic.List[string]]::new();$newNames=[Collections.Generic.List[string]]::new();$stopped=$false
try{
 $null=Invoke-CaddyRepairNative $boot.pm2 @('stop','manager');$stopped=$true
 if($inspection.phpMyAdminRunning){$null=Invoke-CaddyRepairNative $boot.pm2 @('stop','manager-phpmyadmin')}
 foreach($name in $names){
  $destination=[IO.Path]::GetFullPath((Join-Path $target $name))
  $backup=[IO.Path]::GetFullPath((Join-Path $previous $name))
  if(Test-Path -LiteralPath $destination){Move-UpgradeItem $target $previous $name;$oldNames.Add($name)}
  $replacement=Join-Path $stage $name
  if(Test-Path -LiteralPath $replacement){Move-UpgradeItem $stage $target $name;$newNames.Add($name)}
 }
 Save-ManagerOfflineServiceBundle $bundle (Join-Path $dataRoot 'offline-services')
 $null=Invoke-CaddyRepairNative $boot.pm2 @('restart','manager','--update-env')
 if($inspection.phpMyAdminRunning){$null=Invoke-CaddyRepairNative $boot.pm2 @('restart','manager-phpmyadmin','--update-env')}
 $healthy=$false
 for($attempt=0;$attempt -lt 30;$attempt++){
  try{$null=Invoke-CaddyRepairNative $boot.node @((Join-Path $PSScriptRoot 'caddy-repair-check.cjs'),'https',$dataRoot);$healthy=$true;break}catch{Start-Sleep -Seconds 2}
 }
 if(-not $healthy){throw 'Manager HTTPS did not become healthy after the upgrade'}
 if((Get-FileHash -LiteralPath (Join-Path $target '.env.local')).Hash -ne (Get-FileHash -LiteralPath (Join-Path $recovery 'env.local.backup')).Hash){throw 'Manager environment changed unexpectedly'}
 $null=Invoke-CaddyRepairNative $boot.pm2 @('save')
 Write-Host ('PASS: Manager '+$version+' is running. Offline service packages are ready in the dashboard. Recovery: '+$recovery)
}catch{
 $failure=$_.Exception.Message
 if($stopped){
  try{
   $null=Invoke-CaddyRepairNative $boot.pm2 @('stop','manager')
   if($inspection.phpMyAdminRunning){$null=Invoke-CaddyRepairNative $boot.pm2 @('stop','manager-phpmyadmin')}
   $failed=Join-Path $recovery 'failed';New-Item -ItemType Directory -Path $failed | Out-Null
   foreach($name in $newNames){Move-UpgradeItem $target $failed $name}
   foreach($name in $oldNames){Move-UpgradeItem $previous $target $name}
   Copy-Item -LiteralPath (Join-Path $recovery 'dump.pm2') -Destination (Join-Path $dataRoot 'pm2\dump.pm2') -Force
   $null=Invoke-CaddyRepairNative $boot.pm2 @('restart','manager','--update-env')
   if($inspection.phpMyAdminRunning){$null=Invoke-CaddyRepairNative $boot.pm2 @('restart','manager-phpmyadmin','--update-env')}
  }catch{throw ($failure+'. Rollback needs attention: '+$_.Exception.Message+'. Recovery: '+$recovery)}
 }
 throw ($failure+'. Previous application restored. Recovery: '+$recovery)
}
if(Test-Path -LiteralPath (Join-Path $target 'scripts\install-manager-updater.ps1')) {
 & (Join-Path $target 'scripts\install-manager-updater.ps1') -ManagerRoot $target
}
