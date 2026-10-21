# Opt-in: real databases in private temporary directories and on random ports.
# Windows service registration/control is simulated; no host service is changed.
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+$env:PSModulePath
$repo=Split-Path -Parent $PSScriptRoot
. (Join-Path $repo 'scripts\offline-service.ps1')
$native=${function:Invoke-DatabaseNative}
$specification=${function:Get-OfflineServiceSpec}
$sources=@{
 mysql=(Join-Path $repo 'packages\optional-service-validation\mysql\mysql-8.4.13-winx64')
 mariadb=(Join-Path $repo 'packages\optional-service-validation\mariadb\mariadb-11.4.13-winx64')
 mongodb=(Join-Path $repo 'packages\optional-service-validation\mongodb\mongodb-win32-x86_64-windows-7.0.45')
}
$fixtureRoot=Join-Path ([IO.Path]::GetTempPath()) ('manager-offline-service-live-'+[guid]::NewGuid().ToString('N'))
$script:fixtureProcess=$null;$script:registered=$false
function Read-ServicePackage {param($BundleRoot,$Id); return @{Item=@{sha256=('a'*64);version='fixture'};File=$Id}}
function Invoke-ManagerOfflineSetup {param($File,$Arguments,$SuccessCodes); if($File -ne 'vcredist'){throw 'Unexpected vendor installer'}}
function Expand-ManagerOfflineArchive {param($Archive,$Destination)
 & robocopy.exe $sources[$Archive] $Destination /E /XF '*.pdb' /NFL /NDL /NJH /NJS | Out-Null
 if($LASTEXITCODE -gt 7){throw 'Fixture binary copy failed'}
}
function Get-OfflineServiceSpec {param($Id);$spec=& $specification $Id;$spec.Port=$script:fixturePort;$spec.Service='ManagerFixture';return $spec}
function Invoke-DatabaseNative {param($File,$Arguments,$Label)
 if($Arguments -contains '--install'){$script:registered=$true;return}
 & $native $File $Arguments $Label
}
function Get-CimInstance {param($ClassName,$Filter)
 if($ClassName -eq 'Win32_Process'){return CimCmdlets\Get-CimInstance Win32_Process -Filter $Filter}
 if($ClassName -ne 'Win32_Service'){throw 'Unexpected CIM query'}
 if($script:registered){return [pscustomobject]@{Name='ManagerFixture';State=$(if($script:fixtureProcess -and -not $script:fixtureProcess.HasExited){'Running'}else{'Stopped'});StartMode='Auto';ProcessId=$(if($script:fixtureProcess){$script:fixtureProcess.Id}else{0});PathName=('"'+$script:fixtureExe+'" --config fixture')}}
}
function Set-Service {param($Name,$StartupType);if($Name -ne 'ManagerFixture' -or $StartupType -ne 'Automatic'){throw 'Unexpected service change'}}
function Stop-Service {param($Name,$ErrorAction)
 if($Name -ne 'ManagerFixture'){throw 'Unexpected service stop'}
 if($script:fixtureProcess -and -not $script:fixtureProcess.HasExited){
   # Kill only the child process created by this fixture, never a PID from a port.
   & taskkill.exe /PID $script:fixtureProcess.Id /T /F | Out-Null
   $script:fixtureProcess.WaitForExit();$script:fixtureProcess.Dispose();$script:fixtureProcess=$null
 }
}
function Start-Service {param($Name)
 if($Name -ne 'ManagerFixture'){throw 'Unexpected service start'}
 $config=Join-Path $script:fixtureState 'server.conf'
 $arguments=if($script:fixtureEngine -eq 'mongodb'){@('--config',('"'+$config+'"'))}else{@('--defaults-file="'+$config+'"','--console')}
 $script:fixtureProcess=Start-Process -FilePath $script:fixtureExe -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $script:fixtureState 'stderr.log') -RedirectStandardOutput (Join-Path $script:fixtureState 'stdout.log')
}
function Restart-Service {param($Name);Stop-Service $Name;Start-Service $Name}
try{
 foreach($id in @('mysql','mariadb','mongodb')){
  $script:fixtureEngine=$id;$script:registered=$false
  $probe=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$probe.Start();$script:fixturePort=$probe.LocalEndpoint.Port;$probe.Stop()
  $script:fixtureState=Join-Path $fixtureRoot ('services\'+$id)
  $spec=Get-OfflineServiceSpec $id
  $script:fixtureExe=Join-Path (Join-Path $script:fixtureState 'runtime') $spec.Binary
  $context=@{DataRoot=$fixtureRoot;StateRoot=$script:fixtureState;Engine=$id;Bundle='fixture';Node=(Get-Command node.exe).Source;ManagerRoot=$repo}
  Install-OfflineDatabase $context
  $receipt=Get-Content -LiteralPath (Join-Path $script:fixtureState 'service.json') -Raw | ConvertFrom-Json
  if($receipt.phase -ne 'ready'){throw 'Install did not reach ready state'}
  $credentialHash=(Get-FileHash -LiteralPath (Join-Path $script:fixtureState 'credential.dpapi')).Hash
  Install-OfflineDatabase $context
  if((Get-FileHash -LiteralPath (Join-Path $script:fixtureState 'credential.dpapi')).Hash -ne $credentialHash){throw 'Retry replaced credentials'}
  Stop-Service 'ManagerFixture'
  Start-Service 'ManagerFixture'
  Wait-OfflineServiceHealth $receipt
  Invoke-ServiceProbe $context 'verify'
  Stop-Service 'ManagerFixture'
  Write-Host ('PASS: '+$id+' offline initialization, authentication, retry, crash recovery and persisted marker')
 }
}catch{Write-Host ('Fixture retained for diagnosis: '+$fixtureRoot);throw}
finally{
 Stop-Service 'ManagerFixture'
 # Retain this opt-in fixture and logs for review; no live data is ever removed.
 Write-Host ('Validation files: '+$fixtureRoot)
}
