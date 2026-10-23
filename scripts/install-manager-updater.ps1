param(
  [string]$ManagerRoot=(Split-Path -Parent $PSScriptRoot),
  [string]$StateRoot,
  [string]$StartupConfig,
  [string]$StartupTask,
  [string]$ManagerUrl,
  [string]$CaCertificate
)
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if(-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run updater registration as an administrator'}
$ManagerRoot=[IO.Path]::GetFullPath($ManagerRoot).TrimEnd('\')
if(-not $StateRoot){
  $StateRoot=Join-Path $env:ProgramData 'Manager\updates'
  if([IO.Path]::GetPathRoot($StateRoot) -ne [IO.Path]::GetPathRoot($ManagerRoot)){$StateRoot=Join-Path (Split-Path -Parent $ManagerRoot) '.manager-updates'}
}
$StateRoot=[IO.Path]::GetFullPath($StateRoot).TrimEnd('\')
if($StateRoot -eq [IO.Path]::GetPathRoot($StateRoot).TrimEnd('\') -or $StateRoot.StartsWith($ManagerRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or $StateRoot -eq $ManagerRoot){throw 'Recovery must be in a dedicated folder outside Manager'}
if(-not $StartupConfig){
  $StartupConfig=Join-Path $env:ProgramData 'Manager\pm2-startup.json'
  if(-not (Test-Path -LiteralPath $StartupConfig)){$StartupConfig=Join-Path $env:ProgramData 'Manager\startup\config.json'}
}
if(-not $StartupTask){
  $StartupTask='Manager PM2 Startup'
  if(-not (Get-ScheduledTask -TaskName $StartupTask -ErrorAction SilentlyContinue)){$StartupTask='PM2 Auto-Startup'}
}
$boot=Get-Content -LiteralPath $StartupConfig -Raw | ConvertFrom-Json
$node=if($boot.nodeExe){$boot.nodeExe}else{$boot.node}
if(-not (Test-Path -LiteralPath $node -PathType Leaf)){throw 'The registered Node.js executable is missing'}
$task=Get-ScheduledTask -TaskName $StartupTask -ErrorAction Stop
if($task.Principal.UserId -notin @('SYSTEM','S-1-5-18','NT AUTHORITY\SYSTEM')){throw 'Automatic recovery currently requires the standard SYSTEM PM2 startup task'}
if($task.State -eq 'Disabled'){throw 'Enable the PM2 startup task before enabling recovery'}
New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
& icacls.exe $StateRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if($LASTEXITCODE -ne 0){throw 'Could not protect recovery files'}
$sha=[Security.Cryptography.SHA256]::Create()
try{$suffix=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($ManagerRoot.ToLowerInvariant())))).Replace('-','').Substring(0,12)}finally{$sha.Dispose()}
$recoveryTask='Manager Update Recovery '+$suffix
$registerArgs=@((Join-Path $PSScriptRoot 'register-manager-updater.cjs'),$ManagerRoot,$StateRoot,$StartupConfig,$recoveryTask)
if($ManagerUrl){$registerArgs+=@($ManagerUrl);if($CaCertificate){$registerArgs+=@($CaCertificate)}}elseif($CaCertificate){throw 'Supply ManagerUrl when specifying a CA certificate'}
& $node @registerArgs
if($LASTEXITCODE -ne 0){throw 'Updater registration failed'}
$registration=Join-Path $ManagerRoot '.manager-updater.json'
$worker=Join-Path $StateRoot 'runner\manager-update-worker.cjs'
$action=New-ScheduledTaskAction -Execute $node -Argument ('"'+$worker+'" "'+$registration+'" run') -WorkingDirectory $StateRoot
$triggers=@((New-ScheduledTaskTrigger -AtStartup),(New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)))
$principal=New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $recoveryTask -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null
# Recovery runs before PM2 resurrection on boot. The wrapper lives outside the
# replaced application tree, so a power failure cannot remove its entry point.
$savedAction=Join-Path $StateRoot 'startup-action.json'
if(-not (Test-Path -LiteralPath $savedAction)){
  if(@($task.Actions).Count -ne 1){throw 'Expected a single PM2 startup action'}
  $task.Actions[0] | Select-Object Execute,Arguments,WorkingDirectory | ConvertTo-Json | Set-Content -LiteralPath $savedAction -Encoding UTF8
}
$wrapper=Join-Path $StateRoot 'boot.ps1'
@'
param([string]$Registration)
$ErrorActionPreference='Stop'
$c=Get-Content -LiteralPath $Registration -Raw | ConvertFrom-Json
& $c.nodeExe (Join-Path $c.stateRoot 'runner\manager-update-worker.cjs') $Registration files-only
if($LASTEXITCODE -ne 0){throw 'Manager release recovery failed before PM2 startup'}
$original=Get-Content -LiteralPath (Join-Path $c.stateRoot 'startup-action.json') -Raw | ConvertFrom-Json
$options=@{FilePath=$original.Execute;ArgumentList=$original.Arguments;WindowStyle='Hidden';PassThru=$true}
if($original.WorkingDirectory){$options.WorkingDirectory=$original.WorkingDirectory}
$p=Start-Process @options
$p.WaitForExit()
if($p.ExitCode -ne 0){throw 'PM2 startup failed'}
'@ | Set-Content -LiteralPath $wrapper -Encoding UTF8
$wrapped=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$wrapper+'" -Registration "'+$registration+'"') -WorkingDirectory $StateRoot
Set-ScheduledTask -TaskName $StartupTask -Action $wrapped | Out-Null
Write-Host 'Manager updates and independent boot recovery are enabled.'
Write-Host ('Recovery folder: '+$StateRoot)
