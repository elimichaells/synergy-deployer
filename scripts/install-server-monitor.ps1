param(
  [string]$ManagerRoot=(Split-Path $PSScriptRoot -Parent),
  [string]$Pm2Home=(Join-Path $env:USERPROFILE '.pm2'),
  [string]$Pm2PackageRoot=(Join-Path $env:APPDATA 'npm\node_modules\pm2'),
  [string]$DataRoot=(Join-Path $env:ProgramData 'Manager\monitor')
)
$ErrorActionPreference='Stop'
$node=(Get-Command node.exe).Source
$script=Join-Path $ManagerRoot 'scripts\server-monitor.cjs'
if(-not (Test-Path -LiteralPath $script) -or -not (Test-Path -LiteralPath (Join-Path $Pm2PackageRoot 'package.json'))){throw 'Monitor or PM2 package is missing'}
New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null
$webRoot=Split-Path $ManagerRoot -Parent
$logDirectories=@((Join-Path $Pm2Home 'logs'),(Join-Path $webRoot 'logs'),'C:\Caddy\logs') | Where-Object {Test-Path -LiteralPath $_}
$config=@{stateFile=(Join-Path $DataRoot 'state.json');pm2Home=$Pm2Home;pm2PackageRoot=$Pm2PackageRoot;volumes=@([IO.Path]::GetPathRoot($webRoot));logDirectories=@($logDirectories);checks=@(@{name='Manager';url='http://127.0.0.1:4000/login'},@{name='Caddy';url='http://127.0.0.1:2019/config/'})}
$configPath=Join-Path $DataRoot 'config.json'
if(Test-Path -LiteralPath $configPath){
  $previous=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  if($previous.checks){$config.checks=@($previous.checks)}
  if($previous.applications){$config.applications=$previous.applications}
  Copy-Item -LiteralPath $configPath -Destination ($configPath+'.bak') -Force
}
$config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding utf8
# No credentials are stored in this configuration or in the health snapshots.
$action=New-ScheduledTaskAction -Execute $node -Argument ('"'+$script+'" "'+$configPath+'"') -WorkingDirectory $ManagerRoot
$trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(15) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 55) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal=New-ScheduledTaskPrincipal -UserId SYSTEM -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'Manager Server Monitor' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'Manager Server Monitor'
Write-Output 'Manager Server Monitor installed: checks every minute, independently of PM2.'
