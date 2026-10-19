param([Parameter(Mandatory=$true)][string]$ConfigPath,[switch]$ValidateOnly)
$ErrorActionPreference='Stop'
$configuration=Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if(-not $ValidateOnly -and $identity -ne $configuration.accountSid){throw 'Startup account does not match the configured service identity. No processes were changed.'}
$mutex=New-Object Threading.Mutex($false,'Global\Manager-PM2-Startup')
$acquired=$false
try {
  try {$acquired=$mutex.WaitOne(0)} catch [Threading.AbandonedMutexException] {$acquired=$true}
  if(-not $acquired){throw 'Another Manager startup is already running'}
  $env:PM2_HOME=$configuration.pm2Home
  $env:Path=([IO.Path]::GetDirectoryName($configuration.nodeExe))+';'+$configuration.npmPath+';'+$env:Path
  $arguments=@((Join-Path $PSScriptRoot 'pm2-startup.cjs'),$ConfigPath)
  if($ValidateOnly){$arguments+='--validate'}
  & $configuration.nodeExe @arguments
  if($LASTEXITCODE -ne 0){throw 'Manager startup validation/recovery failed. Inspect the saved process list and PM2 registry.'}
} finally {if($acquired){$mutex.ReleaseMutex()};$mutex.Dispose()}
