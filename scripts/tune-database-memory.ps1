param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('mysql', 'mariadb')]
    [string]$Engine,
    # Semicolon-separated key=value pairs, for example "performance_schema=OFF;innodb_log_buffer_size=16M".
    [Parameter(Mandatory = $true)]
    [string]$Settings,
    [string]$ServiceName
)

# Applies memory settings to a MySQL or MariaDB server. The new file is checked by the server
# itself before anything restarts; if the restarted server does not come back, the previous file
# is restored and the server restarted again.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + ';' + $env:PSModulePath
. (Join-Path $PSScriptRoot 'database-service.ps1')

$allowed = @{
    'performance_schema'      = '^(ON|OFF)$'
    'mysqlx'                  = '^(ON|OFF)$'
    'innodb_log_buffer_size'  = '^[0-9]{1,6}[KMG]?$'
    'innodb_buffer_pool_size' = '^[0-9]{1,6}[KMG]?$'
}
$changes = [ordered]@{}
foreach ($pair in ($Settings -split ';' | Where-Object { $_.Trim() })) {
    $parts = $pair -split '=', 2
    if ($parts.Count -ne 2) { throw "Setting '$pair' is not key=value" }
    $key = $parts[0].Trim().ToLowerInvariant(); $value = $parts[1].Trim().ToUpperInvariant()
    if (-not $allowed.ContainsKey($key)) { throw "Setting $key is not one this script changes" }
    if ($value -notmatch $allowed[$key]) { throw "Value '$value' is not valid for $key" }
    if ($Engine -eq 'mariadb' -and $key -eq 'mysqlx') { throw 'MariaDB has no X protocol to turn off' }
    $changes[$key] = $value
}
if ($changes.Count -eq 0) { throw 'No settings to apply' }

$service = Get-DatabaseService $Engine $ServiceName
if (-not $service) { throw "No installed $Engine Windows service was found" }
$ServiceName = $service.Name
$executable = (Get-Item -LiteralPath (Get-DatabaseServiceExecutable $service.PathName)).FullName
$configPath = Get-DatabaseDefaultsFile $executable $service.PathName ''
$options = Read-DatabaseOptions $executable $configPath $ServiceName
$port = if ($options.ContainsKey('port')) { [int]$options.port } else { 3306 }
$section = if ($Engine -eq 'mysql' -and $ServiceName -ne 'MySQL') { $ServiceName } else { 'mysqld' }

$original = [IO.File]::ReadAllBytes($configPath)
$backup = "$configPath.before-tuning-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
[IO.File]::WriteAllBytes($backup, $original)
Write-Host "[tune] Saved the current settings to $backup"

$lines = [System.Collections.Generic.List[string]]::new()
foreach ($line in [IO.File]::ReadAllLines($configPath)) { $lines.Add($line) }
foreach ($key in $changes.Keys) { Set-DatabaseServerOption $lines $section $key $changes[$key] }
if ($changes['mysqlx'] -eq 'OFF') {
    # With the X plugin off its own options are unknown; "loose-" keeps the server starting.
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -match '^\s*(mysqlx[-_][^=\s]+)\s*=(.*)$') { $lines[$index] = "loose-$($matches[1])=$($matches[2].Trim())" }
    }
}
[IO.File]::WriteAllLines($configPath, $lines, [Text.UTF8Encoding]::new($false))

function Restore-Original([string]$Reason) {
    [IO.File]::WriteAllBytes($configPath, $original)
    Write-Host "[tune] Restored the previous settings: $Reason"
}

function Wait-DatabaseReady {
    $running = Get-Service -Name $ServiceName
    $running.WaitForStatus('Running', [TimeSpan]::FromSeconds(90))
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { return $true }
        $refreshed = Get-CimInstance Win32_Service -Filter "Name='$($ServiceName.Replace("'", "''"))'"
        if ($refreshed.State -ne 'Running') { return $false }
        Start-Sleep -Seconds 1
    }
    return $false
}

# The server checks the new file without starting; a rejected file never reaches a restart.
if ($Engine -eq 'mysql') {
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $check = @(& $executable ("--defaults-file=$configPath") '--validate-config' 2>&1)
        $checkCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previous }
    if ($checkCode -ne 0) {
        Restore-Original 'MySQL rejected the new settings'
        throw ("MySQL rejected the new settings; nothing was restarted. " + (($check | Select-Object -Last 3) -join ' '))
    }
    Write-Host '[tune] MySQL accepted the new settings'
}

Write-Host "[tune] Restarting $ServiceName"
$started = $false
try {
    Restart-Service -Name $ServiceName -ErrorAction Stop
    $started = Wait-DatabaseReady
} catch { $started = $false }

if (-not $started) {
    Restore-Original 'the server did not come back with the new settings'
    try {
        Restart-Service -Name $ServiceName -ErrorAction Stop
        $restored = Wait-DatabaseReady
    } catch { $restored = $false }
    $state = if ($restored) { 'It is running again with the previous settings.' } else { 'It did not start with the previous settings either; check its error log.' }
    throw "The database server did not come back after the change. $state"
}

Write-Host "[tune] $ServiceName is running on port $port with the new settings"
Write-Output ('RESULT ' + (@{ ok = $true; service = $ServiceName; config = $configPath; backup = $backup; port = $port } | ConvertTo-Json -Compress))
