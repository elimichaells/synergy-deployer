$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$stage = $PSScriptRoot
$agentRoot = Join-Path $env:ProgramData 'ManagerAgent'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'SSH setup needs an elevated administrator account.' }
if (Test-Path -LiteralPath $agentRoot) {
  if ((Get-Item -LiteralPath $agentRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Agent data directory cannot be a junction or symbolic link.' }
  if ((Get-ChildItem -LiteralPath $agentRoot -Force | Select-Object -First 1) -and -not (Test-Path -LiteralPath (Join-Path $agentRoot '.manager-bootstrap'))) { throw 'The agent data directory is not empty. Use a dedicated target.' }
}
if (Test-Path -LiteralPath (Join-Path $agentRoot 'agent.json')) { throw 'An agent enrollment already exists. Inspect it locally before retrying setup.' }
if (Get-ScheduledTask -TaskName 'ManagerRemoteAgent' -ErrorAction SilentlyContinue) { throw 'An existing ManagerRemoteAgent task must be inspected before setup.' }
if (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(80,443,2029) }) { throw 'Ports 80, 443 or 2029 are in use. Plan the existing web-server migration first.' }
New-Item -ItemType Directory -Force -Path $agentRoot | Out-Null
& icacls.exe $agentRoot /inheritance:r /grant:r ($identity.Name + ':(OI)(CI)F') '*S-1-5-19:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not protect the agent data folder' }
New-Item -ItemType File -Force -Path (Join-Path $agentRoot '.manager-bootstrap') | Out-Null
$downloads = Get-Content -LiteralPath (Join-Path $stage 'downloads.json') -Raw | ConvertFrom-Json
$toolsRoot = Join-Path $agentRoot 'tools'
New-Item -ItemType Directory -Force -Path $toolsRoot | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
function Get-VerifiedArchive($asset, [string]$target) {
  Invoke-WebRequest -UseBasicParsing -Uri $asset.url -OutFile $target
  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $asset.sha256) { throw 'Installer SHA-256 verification failed' }
}
Write-Output '[setup] Downloading and verifying Node.js, Git and Caddy'
$nodeArchive = Join-Path $toolsRoot 'node.zip'
Get-VerifiedArchive $downloads.node $nodeArchive
$nodeExtract = Join-Path $toolsRoot 'node-extract'
Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract -Force
$nodeFolders = @(Get-ChildItem -LiteralPath $nodeExtract -Directory | Where-Object { $_.Name -match '^node-v[0-9.]+-win-x64$' })
if ($nodeFolders.Count -ne 1) { throw 'Unexpected Node.js archive contents' }
$nodeRoot = Join-Path $toolsRoot 'node'
New-Item -ItemType Directory -Force -Path $nodeRoot | Out-Null
Get-ChildItem -LiteralPath $nodeFolders[0].FullName | Copy-Item -Destination $nodeRoot -Recurse -Force
foreach ($tool in @('git','caddy')) {
  $archive = Join-Path $toolsRoot ($tool + '.zip')
  Get-VerifiedArchive $downloads.$tool $archive
  Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $toolsRoot $tool) -Force
}
$env:Path = $nodeRoot + ';' + (Join-Path $toolsRoot 'git\cmd') + ';' + (Join-Path $toolsRoot 'caddy') + ';' + $env:Path
$nodeExe = Join-Path $nodeRoot 'node.exe'
Write-Output '[setup] Installing private PM2 tools'
& $nodeExe (Join-Path $nodeRoot 'node_modules\npm\bin\npm-cli.js') install --prefix $toolsRoot --omit=dev --no-audit --no-fund ('pm2@' + $downloads.pm2Version)
if ($LASTEXITCODE -ne 0) { throw 'PM2 installation failed' }
Copy-Item -LiteralPath (Join-Path $stage 'manager-agent.cjs') -Destination (Join-Path $agentRoot 'manager-agent.cjs') -Force
$enrollmentFile = Join-Path $agentRoot 'enrollment.json'
Copy-Item -LiteralPath (Join-Path $stage 'enrollment.json') -Destination $enrollmentFile -Force
if (Test-Path -LiteralPath (Join-Path $stage 'manager-ca.crt')) {
  Copy-Item -LiteralPath (Join-Path $stage 'manager-ca.crt') -Destination (Join-Path $agentRoot 'manager-ca.crt') -Force
  $env:NODE_EXTRA_CA_CERTS = Join-Path $agentRoot 'manager-ca.crt'
}
Write-Output '[setup] Enrolling with Manager'
try {
  & $nodeExe (Join-Path $agentRoot 'manager-agent.cjs') enroll --root $agentRoot --enrollment-file $enrollmentFile
  if ($LASTEXITCODE -ne 0) { throw 'Agent enrollment failed. Check the Manager HTTPS address, routing and certificate trust.' }
} finally { Remove-Item -LiteralPath $enrollmentFile -Force -ErrorAction SilentlyContinue }
$launcher = @'
$ErrorActionPreference = 'Stop'
$agentRoot = $PSScriptRoot
$env:Path = (Join-Path $agentRoot 'tools\node') + ';' + (Join-Path $agentRoot 'tools\git\cmd') + ';' + (Join-Path $agentRoot 'tools\caddy') + ';' + $env:Path
$env:MANAGER_AGENT_CADDY = Join-Path $agentRoot 'tools\caddy\caddy.exe'
if (Test-Path -LiteralPath (Join-Path $agentRoot 'manager-ca.crt')) { $env:NODE_EXTRA_CA_CERTS = Join-Path $agentRoot 'manager-ca.crt' }
& (Join-Path $agentRoot 'tools\node\node.exe') (Join-Path $agentRoot 'manager-agent.cjs') run --root $agentRoot
exit $LASTEXITCODE
'@
$launcherPath = Join-Path $agentRoot 'start-agent.ps1'
[IO.File]::WriteAllText($launcherPath, $launcher)
$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcherPath + '"') -WorkingDirectory $agentRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 20 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
$servicePrincipal = New-ScheduledTaskPrincipal -UserId 'S-1-5-19' -LogonType ServiceAccount -RunLevel Limited
Register-ScheduledTask -TaskName 'ManagerRemoteAgent' -Action $action -Trigger $trigger -Settings $settings -Principal $servicePrincipal | Out-Null
Start-ScheduledTask -TaskName 'ManagerRemoteAgent'
Write-Output '[setup] Agent startup task started. Waiting for a heartbeat in Manager.'
