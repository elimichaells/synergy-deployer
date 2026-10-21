$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+$env:PSModulePath
$dataRoot=Join-Path $env:ProgramData 'Manager'
$boot=Get-Content -LiteralPath (Join-Path $dataRoot 'pm2-startup.json') -Raw | ConvertFrom-Json
foreach($engine in @('mysql','mariadb','mongodb','sqlserver')){
 if(Test-Path -LiteralPath (Join-Path $dataRoot ('services\'+$engine+'\service.json'))){
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'offline-service.ps1') -Engine $engine -Action Verify
  if($LASTEXITCODE -ne 0){throw ($engine+' failed post-reboot verification')}
 }
}
& $boot.node (Join-Path $PSScriptRoot 'caddy-repair-check.cjs') https $dataRoot
if($LASTEXITCODE -ne 0){throw 'Manager HTTPS verification failed'}
$task=Get-ScheduledTask -TaskName 'Manager PM2 Startup'
if($task.State -eq 'Disabled'){throw 'Manager startup task is disabled'}
if(Test-Path -LiteralPath (Join-Path $dataRoot 'services\phpmyadmin\VERSION')){
 $response=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8433/' -TimeoutSec 10
 if($response.StatusCode -ne 200){throw 'phpMyAdmin is not ready'}
}
Write-Host 'PASS: installed offline databases, their persisted data, Manager HTTPS and installed phpMyAdmin verified'
