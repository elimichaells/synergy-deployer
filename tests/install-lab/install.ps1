param([Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Release,[switch]$CandidateInstaller,[string]$PackageDirectory)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows' -or $env:MANAGER_INSTALL_LAB -ne '1') {
  throw 'This lab is restricted to a disposable GitHub-hosted Windows VM. Never run on a production host.'
}
$root='C:\ManagerAcceptanceLab'
if ((Test-Path -LiteralPath $root) -or (Test-Path -LiteralPath 'C:\ProgramData\Manager') -or (Test-Path -LiteralPath 'C:\web\manager\.env.local')) { throw 'The disposable VM already contains Manager or lab state.' }
New-Item -ItemType Directory -Path $root,(Join-Path $root 'private'),(Join-Path $root 'results') | Out-Null
& icacls.exe (Join-Path $root 'private') /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if($LASTEXITCODE){throw 'Could not protect lab credentials'}
$secrets=@()
function New-LabSecret { $value='Aa1!'+[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)); Write-Host "::add-mask::$value"; return $value }
function Save-Json($value,[string]$file){[IO.File]::WriteAllText($file,($value|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))}
$private=Join-Path $root 'private'
$results=Join-Path $root 'results'
$record=[ordered]@{status='failed';version=$Release;runner=$env:ImageOS;runId=$env:GITHUB_RUN_ID;computer=$env:COMPUTERNAME;bootBefore=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o');startedAt=(Get-Date).ToUniversalTime().ToString('o')}
try {
  # These are disposable image services, never production services. Their data is not deleted.
  foreach($service in @(Get-CimInstance Win32_Service | Where-Object {$_.Name -match '^postgresql' -or $_.Name -in @('W3SVC','WAS','WMSVC','Apache','nginx')})){
    if($service.State -eq 'Running'){Stop-Service -Name $service.Name -Force}
    if($service.Name -match '^postgresql'){& sc.exe delete $service.Name | Out-Null; if($LASTEXITCODE){throw 'Could not clear disposable image PostgreSQL service registration'}}
    else{Set-Service -Name $service.Name -StartupType Disabled}
  }
  if($PackageDirectory){
    if($CandidateInstaller){throw 'A complete candidate package must not have installer overrides'}
    $releaseInfo=@{assets=@(Get-ChildItem -LiteralPath $PackageDirectory -File | ForEach-Object { @{name=$_.Name;localPath=$_.FullName} })}
    $record.candidatePackage=$true
  }else{
    $releaseInfo=Invoke-RestMethod "https://api.github.com/repos/elimichaells/synergy-deployer/releases/tags/v$Release"
    if($releaseInfo.draft -or $releaseInfo.prerelease){throw 'Expected a published stable release'}
  }
  $zip=@($releaseInfo.assets | Where-Object name -match "^manager-windows-$([regex]::Escape($Release))-\d+-\d+\.zip$")
  $exe=@($releaseInfo.assets | Where-Object name -match "^manager-setup-$([regex]::Escape($Release))-\d+-\d+\.exe$")
  if($zip.Count -ne 1 -or $exe.Count -ne 1){throw 'Expected exactly one Windows ZIP and setup executable'}
  foreach($asset in @($zip[0],$exe[0])){
    $manifestAsset=@($releaseInfo.assets | Where-Object name -eq ($asset.name+'.sha256.json'))[0]
    $destination=Join-Path $root $asset.name
    if($PackageDirectory){
      $manifest=Get-Content -LiteralPath $manifestAsset.localPath -Raw | ConvertFrom-Json
      if($manifest.sourceCommit -ne $env:GITHUB_SHA){throw 'Candidate package does not match this tested checkout'}
      Copy-Item -LiteralPath $asset.localPath -Destination $destination
    }else{
      if(!$asset.browser_download_url.StartsWith("https://github.com/elimichaells/synergy-deployer/releases/download/v$Release/")){throw 'Unexpected package origin'}
      $manifest=Invoke-RestMethod $manifestAsset.browser_download_url
      Invoke-WebRequest $asset.browser_download_url -OutFile $destination
    }
    if((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $manifest.sha256 -or $manifest.version -ne $Release -or $manifest.sourceDirty){throw 'Published package identity mismatch'}
    $record.sourceCommit=$manifest.sourceCommit
  }
  $smoke=Start-Process -FilePath (Join-Path $root $exe[0].name) -ArgumentList @('--smoke-test','--smoke-report',(Join-Path $results 'installer-smoke.txt')) -WindowStyle Hidden -Wait -PassThru
  if($smoke.ExitCode -ne 0){throw 'Setup executable rejected its embedded package'}
  $source=Join-Path $root 'package'
  Expand-Archive -LiteralPath (Join-Path $root $zip[0].name) -DestinationPath $source
  if(!(Test-Path -LiteralPath (Join-Path $source 'scripts\install-manager.ps1'))){throw 'Installer engine absent from package'}
  if($CandidateInstaller){
    foreach($file in @('install-manager.ps1','installer-preflight.ps1','manager-update-worker.cjs','server-monitor.cjs','operations-pm2.cjs')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('..\..\scripts\'+$file)) -Destination (Join-Path $source ('scripts\'+$file)) -Force}
    $record.candidateInstaller=$env:GITHUB_SHA
  }
  $managerAddress='localhost'
  if($env:LAB_ADDRESS_MODE -eq 'private-ip'){
    $managerAddress=@(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)'} | Select-Object -ExpandProperty IPAddress)[0]
    if(!$managerAddress){throw 'Disposable VM has no private IPv4 interface'}
  }
  $record.addressMode=$env:LAB_ADDRESS_MODE
  $config=[ordered]@{
    ManagerDomain=$managerAddress;ManagerAccessMode='local';ManagerAllowedNetworks=@('127.0.0.1',$(if($managerAddress -eq 'localhost'){'::1'}else{$managerAddress}));ManagerPort=4000
    ManagerRoot='C:\ManagerAcceptanceLab\web\manager';WebRoot='C:\ManagerAcceptanceLab\web'
    AdminName='Isolated lab administrator';AdminEmail='admin@manager-lab.test';AdminPassword=(New-LabSecret)
    DbHost='127.0.0.1';DbPort=5432;DbName='manager_lab_control';DbAdminUser='manager_lab_admin';DbAdminPassword=(New-LabSecret)
    DbAppUser='manager_lab_app';DbAppPassword=(New-LabSecret);InstallPostgreSQL=$true
    InstallApplicationPostgreSQL=$true;AppDbPort=5433;AppDbAdminUser='manager_lab_project_admin';AppDbAdminPassword=(New-LabSecret)
    AppDbDataDirectory='C:\ManagerAcceptanceLab\custom application postgres';AppDbServiceName='ManagerPostgreSQLApplications'
    InstallPgweb=$true;InstallLatestNpm=$false;OptionalRuntimes=@();OptionalDatabaseEngines=@();PostgreSqlBinDirectory=$env:PGBIN
  }
  $secrets=@($config.AdminPassword,$config.DbAdminPassword,$config.DbAppPassword,$config.AppDbAdminPassword)
  Save-Json $config (Join-Path $private 'install.json')
  Save-Json @{runId=$env:GITHUB_RUN_ID;computer=$env:COMPUTERNAME;sourceCommit=$env:GITHUB_SHA;root=$root;node=(Get-Command node).Source;workspace=$env:GITHUB_WORKSPACE} (Join-Path $private 'identity.json')
  # Direct file handles avoid waiting for EOF on a pipe inherited by PM2's daemon.
  $installerArgs=@('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+(Join-Path $source 'scripts\install-manager.ps1')+'"'),'-Unattended','-ConfigPath',('"'+(Join-Path $private 'install.json')+'"'))
  $installer=Start-Process powershell.exe -ArgumentList $installerArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $private 'installer.log') -RedirectStandardError (Join-Path $private 'installer-error.log')
  $deadline=(Get-Date).AddMinutes(35)
  while(-not $installer.HasExited){
    if((Get-Date) -gt $deadline){throw 'Installer exceeded 35 minutes on the disposable VM'}
    Start-Sleep -Seconds 20
    foreach($file in @('installer.log','installer-error.log')){
      $tail=(Get-Content -LiteralPath (Join-Path $private $file) -Tail 4 -ErrorAction SilentlyContinue) -join "`n"
      foreach($secret in $secrets){$tail=$tail.Replace($secret,'[redacted]')}
      Write-Host $tail
    }
    $installer.Refresh()
  }
  if($installer.ExitCode){throw "Real installer failed with exit code $($installer.ExitCode)"}
  $env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')
  $env:PM2_HOME='C:\ProgramData\Manager\pm2'
  & node (Join-Path $PSScriptRoot 'verify.cjs') before
  if($LASTEXITCODE){throw 'Fresh installation verification failed'}
  $record.status='passed';$record.freshInstall=$true
  Write-Host '[pass] Published installer completed; authenticated HTTPS, isolated databases, local CA and startup registration verified.'
} catch { $record.error=$_.Exception.Message; throw }
finally {
  Save-Json $record (Join-Path $results 'install-result.json')
  if($record.status -ne 'passed'){
    $diagnostics=@()
    $diagnostics+=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$_.LocalPort -in @(80,443,4000,5432,5433)} | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json)
    foreach($file in @(Get-ChildItem -LiteralPath 'C:\ProgramData\Manager\pm2\logs' -Filter '*caddy*' -File -ErrorAction SilentlyContinue)){
      $diagnostics+=$file.Name
      $diagnostics+=(Get-Content -LiteralPath $file.FullName -Tail 50 -ErrorAction SilentlyContinue) -join "`n"
    }
    $text=$diagnostics -join "`n"
    foreach($secret in $secrets){$text=$text.Replace($secret,'[redacted]')}
    [IO.File]::WriteAllText((Join-Path $results 'service-diagnostics.txt'),$text,[Text.UTF8Encoding]::new($false))
    Write-Host $text
  }
  if(Test-Path -LiteralPath (Join-Path $private 'installer.log')){
    # PM2 can retain inherited handles after the installer exits. Read with shared
    # access so diagnostics never mask the original installation failure.
    $log=Get-Content -LiteralPath (Join-Path $private 'installer.log') -Raw
    if(Test-Path -LiteralPath (Join-Path $private 'installer-error.log')){$log+="`n"+(Get-Content -LiteralPath (Join-Path $private 'installer-error.log') -Raw)}
    foreach($secret in $secrets){$log=$log.Replace($secret,'[redacted]')}
    [IO.File]::WriteAllText((Join-Path $results 'installer.log'),$log,[Text.UTF8Encoding]::new($false))
    Get-Content -LiteralPath (Join-Path $results 'installer.log') -Tail 100
  }
}
