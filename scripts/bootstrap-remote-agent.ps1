$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$stage = $PSScriptRoot
$agentRoot = Join-Path $env:ProgramData 'ManagerAgent'
$proxyFile = Join-Path $stage 'proxy.json'
$sharedProxy = if (Test-Path -LiteralPath $proxyFile) { Get-Content -LiteralPath $proxyFile -Raw | ConvertFrom-Json } else { $null }
if ($sharedProxy -and $sharedProxy.mode -ne 'existing-caddy') { throw 'Unsupported prepared proxy configuration' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'SSH setup needs an elevated administrator account.' }
if (Test-Path -LiteralPath $agentRoot) {
  if ((Get-Item -LiteralPath $agentRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Agent data directory cannot be a junction or symbolic link.' }
  if ((Get-ChildItem -LiteralPath $agentRoot -Force | Select-Object -First 1) -and -not (Test-Path -LiteralPath (Join-Path $agentRoot '.manager-bootstrap'))) { throw 'The agent data directory is not empty. Use a dedicated target.' }
}
if (Test-Path -LiteralPath (Join-Path $agentRoot 'agent.json')) { throw 'An agent enrollment already exists. Inspect it locally before retrying setup.' }
if (Get-ScheduledTask -TaskName 'ManagerRemoteAgent' -ErrorAction SilentlyContinue) { throw 'An existing ManagerRemoteAgent task must be inspected before setup.' }
if (-not $sharedProxy -and (Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -in @(80,443,2029) })) { throw 'Ports 80, 443 or 2029 are in use. Plan the existing web-server migration first.' }
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
Write-Output '[setup] Reusing selected tools and installing only missing prerequisites'
$paths = @{}
$selected = Get-Content -LiteralPath (Join-Path $stage 'tool-paths.json') -Raw | ConvertFrom-Json
foreach ($property in $selected.PSObject.Properties) { $paths[$property.Name] = [string]$property.Value }
if ($downloads.node) {
$nodeArchive = Join-Path $toolsRoot 'node.zip'
Get-VerifiedArchive $downloads.node $nodeArchive
$nodeExtract = Join-Path $toolsRoot 'node-extract'
Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract -Force
$nodeFolders = @(Get-ChildItem -LiteralPath $nodeExtract -Directory | Where-Object { $_.Name -match '^node-v[0-9.]+-win-x64$' })
if ($nodeFolders.Count -ne 1) { throw 'Unexpected Node.js archive contents' }
$nodeRoot = Join-Path $toolsRoot 'node'
New-Item -ItemType Directory -Force -Path $nodeRoot | Out-Null
Get-ChildItem -LiteralPath $nodeFolders[0].FullName | Copy-Item -Destination $nodeRoot -Recurse -Force
$paths.node = Join-Path $nodeRoot 'node.exe'
}
$nodeExe = $paths.node
if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) { throw 'Selected Node.js executable is unavailable' }
$nodeRoot = Split-Path -Parent $nodeExe
foreach ($tool in @('git','caddy')) {
  if (-not $downloads.$tool) { continue }
  $archive = Join-Path $toolsRoot ($tool + '.zip')
  Get-VerifiedArchive $downloads.$tool $archive
  Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $toolsRoot $tool) -Force
  $paths[$tool] = if ($tool -eq 'git') { Join-Path $toolsRoot 'git\cmd\git.exe' } else { Join-Path $toolsRoot 'caddy\caddy.exe' }
}
$env:Path = $nodeRoot + ';' + $env:Path
if ($downloads.pm2Version) {
Write-Output '[setup] Installing private PM2 tools'
& $nodeExe (Join-Path $nodeRoot 'node_modules\npm\bin\npm-cli.js') install --prefix $toolsRoot --omit=dev --no-audit --no-fund ('pm2@' + $downloads.pm2Version)
if ($LASTEXITCODE -ne 0) { throw 'PM2 installation failed' }
$paths.pm2 = Join-Path $toolsRoot 'node_modules\pm2\bin\pm2'
}
[IO.File]::WriteAllText((Join-Path $agentRoot 'tool-paths.json'), ($paths | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
Copy-Item -LiteralPath (Join-Path $stage 'manager-agent.cjs') -Destination (Join-Path $agentRoot 'manager-agent.cjs') -Force
Copy-Item -LiteralPath (Join-Path $stage 'manager-agent-supervisor.cjs') -Destination (Join-Path $agentRoot 'manager-agent-supervisor.cjs') -Force
if ($sharedProxy) {
  Copy-Item -LiteralPath $proxyFile -Destination (Join-Path $agentRoot 'proxy.json')
  New-Item -ItemType Directory -Force -Path (Join-Path $agentRoot 'managed-sites') | Out-Null
}
$enrollmentFile = Join-Path $agentRoot 'enrollment.json'
Copy-Item -LiteralPath (Join-Path $stage 'enrollment.json') -Destination $enrollmentFile -Force
if (Test-Path -LiteralPath (Join-Path $stage 'manager-ca.crt')) {
  Copy-Item -LiteralPath (Join-Path $stage 'manager-ca.crt') -Destination (Join-Path $agentRoot 'manager-ca.crt') -Force
  $env:NODE_EXTRA_CA_CERTS = Join-Path $agentRoot 'manager-ca.crt'
}
Write-Output '[setup] Checking tools and enrolling under the Local Service account'
$launcher = @'
$ErrorActionPreference = 'Stop'
$agentRoot = $PSScriptRoot
$paths = Get-Content -LiteralPath (Join-Path $agentRoot 'tool-paths.json') -Raw | ConvertFrom-Json
$env:Path = (Split-Path -Parent $paths.node) + ';' + $env:Path
if (Test-Path -LiteralPath (Join-Path $agentRoot 'manager-ca.crt')) { $env:NODE_EXTRA_CA_CERTS = Join-Path $agentRoot 'manager-ca.crt' }
$enrollment = Join-Path $agentRoot 'enrollment.json'
if (Test-Path -LiteralPath $enrollment) {
  try {
    & $paths.node (Join-Path $agentRoot 'manager-agent.cjs') check-tools --root $agentRoot
    if ($LASTEXITCODE -ne 0) { throw 'Selected tools are not accessible to Local Service. Inspect tool-check.json.' }
    & $paths.node (Join-Path $agentRoot 'manager-agent.cjs') enroll --root $agentRoot --enrollment-file $enrollment
    if ($LASTEXITCODE -ne 0) { throw 'Agent enrollment failed' }
  } finally { Remove-Item -LiteralPath $enrollment -Force -ErrorAction SilentlyContinue }
}
& $paths.node (Join-Path $agentRoot 'manager-agent-supervisor.cjs') --root $agentRoot
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
$ready = $false
for ($attempt = 0; $attempt -lt 45; $attempt++) {
  Start-Sleep -Seconds 2
  $checkFile = Join-Path $agentRoot 'tool-check.json'
  if (Test-Path -LiteralPath $checkFile) {
    $check = Get-Content -LiteralPath $checkFile -Raw | ConvertFrom-Json
    if (-not $check.ok) { throw ('Agent account tool check failed: ' + $check.error) }
  }
  $configFile = Join-Path $agentRoot 'agent.json'
  if ((Test-Path -LiteralPath $configFile) -and (Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json).enrolled) { $ready = $true; break }
}
if (-not $ready) { throw 'Agent account did not complete enrollment. Check tool-check.json, selected file permissions and the startup task before retrying.' }
Write-Output '[setup] Agent startup task started. Waiting for a heartbeat in Manager.'
