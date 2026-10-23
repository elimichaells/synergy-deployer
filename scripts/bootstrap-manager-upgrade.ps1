param(
  [string]$ManagerRoot='C:\web\manager',
  [string]$OfflineDirectory,
  [string]$StateRoot,
  [string]$StartupConfig,
  [string]$StartupTask,
  [string]$ManagerUrl,
  [string]$CaCertificate
)
$ErrorActionPreference='Stop'
# The release workflow replaces both constants. Download this script from the official release.
$releaseVersion='@@VERSION@@'
$runtimeSha256='@@BOOTSTRAP_SHA256@@'
if($runtimeSha256 -notmatch '^[a-f0-9]{64}$'){throw 'Use the generated bootstrap script attached to the GitHub release'}
$identity=[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if(-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run this one-time upgrade in an Administrator PowerShell'}
$ManagerRoot=[IO.Path]::GetFullPath($ManagerRoot).TrimEnd('\')
if(-not (Test-Path -LiteralPath (Join-Path $ManagerRoot '.env.local'))){throw 'ManagerRoot must be an existing Manager installation'}
if(-not $StartupConfig){
  $StartupConfig=Join-Path $env:ProgramData 'Manager\pm2-startup.json'
  if(-not (Test-Path -LiteralPath $StartupConfig)){$StartupConfig=Join-Path $env:ProgramData 'Manager\startup\config.json'}
}
$boot=Get-Content -LiteralPath $StartupConfig -Raw | ConvertFrom-Json
$node=if($boot.nodeExe){$boot.nodeExe}else{$boot.node}
if(-not (Test-Path -LiteralPath $node -PathType Leaf)){throw 'The registered Node.js executable is missing'}
$runtime=(& $node -p 'JSON.stringify({major:parseInt(process.versions.node),platform:process.platform,arch:process.arch})') | ConvertFrom-Json
if($LASTEXITCODE -ne 0 -or $runtime.platform -ne 'win32' -or $runtime.arch -ne 'x64' -or $runtime.major -notin @(22,24)){throw 'This bootstrap requires the existing Windows x64 Node 22 or 24 runtime'}
if(-not $StateRoot){
  $StateRoot=Join-Path $env:ProgramData 'Manager\updates'
  if([IO.Path]::GetPathRoot($StateRoot) -ne [IO.Path]::GetPathRoot($ManagerRoot)){$StateRoot=Join-Path (Split-Path -Parent $ManagerRoot) '.manager-updates'}
}
$StateRoot=[IO.Path]::GetFullPath($StateRoot).TrimEnd('\')
if($StateRoot -eq [IO.Path]::GetPathRoot($StateRoot).TrimEnd('\') -or $StateRoot.StartsWith($ManagerRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or $ManagerRoot.StartsWith($StateRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or $StateRoot -eq $ManagerRoot){throw 'Recovery must use a dedicated folder outside Manager'}
New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
& icacls.exe $StateRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if($LASTEXITCODE -ne 0){throw 'Could not protect recovery files'}
$workspace=Join-Path $StateRoot ('bootstrap\'+[guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $workspace -Force | Out-Null
$base='https://github.com/elimichaells/synergy-deployer/releases/download/v'+$releaseVersion+'/'
$assets=@('manager-bootstrap-runtime.zip',('manager-update-win32-x64-node'+$runtime.major+'.tar'))
foreach($asset in $assets){
  $destination=Join-Path $workspace $asset
  if($OfflineDirectory){Copy-Item -LiteralPath (Join-Path $OfflineDirectory $asset) -Destination $destination}
  else{Write-Host ('Downloading '+$asset);[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;Invoke-WebRequest -UseBasicParsing -Uri ($base+$asset) -OutFile $destination -TimeoutSec 1800}
}
$zip=Join-Path $workspace $assets[0]
if((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $runtimeSha256){throw 'Bootstrap runtime checksum does not match this official release script'}
$toolRoot=Join-Path $workspace 'runtime'
Expand-Archive -LiteralPath $zip -DestinationPath $toolRoot
$entry=Join-Path $toolRoot 'scripts\bootstrap-manager-upgrade.cjs'
$prepared=Join-Path $workspace 'verified'
Write-Host 'Verifying and staging the signed update. Manager remains online during preparation.'
& $node $entry verify $ManagerRoot (Join-Path $workspace $assets[1]) $prepared
if($LASTEXITCODE -ne 0){throw ('Update verification failed. Inspection files: '+$workspace)}
$registration=@{ManagerRoot=$ManagerRoot;StateRoot=$StateRoot;StartupConfig=$StartupConfig}
if($StartupTask){$registration.StartupTask=$StartupTask}
if($ManagerUrl){$registration.ManagerUrl=$ManagerUrl}
if($CaCertificate){$registration.CaCertificate=$CaCertificate}
& (Join-Path $toolRoot 'scripts\install-manager-updater.ps1') @registration
& $node $entry install $ManagerRoot $prepared
if($LASTEXITCODE -ne 0){throw ('Upgrade needs attention. Read the protected recovery state in '+$StateRoot)}
Write-Host 'Upgrade complete. Sign in and open Settings > Manager updates, or Infrastructure > Servers.'
