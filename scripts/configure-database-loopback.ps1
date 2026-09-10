param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('mysql', 'mariadb')]
    [string]$Engine
)

$ErrorActionPreference = 'Stop'

function Get-DatabaseService([string]$Name) {
    $services = @(Get-CimInstance Win32_Service | Where-Object {
        $_.PathName -match '(?i)mysqld(?:\.exe)?' -or $_.Name -match '(?i)mysql|maria'
    })
    if ($Name -eq 'mysql') {
        return $services | Where-Object {
            ($_.Name -match '(?i)^mysql' -or $_.DisplayName -match '(?i)^mysql') -and
            $_.Name -notmatch '(?i)maria' -and $_.DisplayName -notmatch '(?i)maria' -and $_.PathName -notmatch '(?i)maria'
        } | Select-Object -First 1
    }
    return $services | Where-Object {
        $_.Name -match '(?i)maria' -or $_.DisplayName -match '(?i)maria' -or $_.PathName -match '(?i)maria'
    } | Select-Object -First 1
}

function Set-ServerOption([System.Collections.Generic.List[string]]$Lines, [string]$Key, [string]$Value) {
    $sectionStart = -1
    $sectionEnd = $Lines.Count
    for ($index = 0; $index -lt $Lines.Count; $index++) {
        if ($Lines[$index] -match '^\s*\[mysqld\]\s*$') {
            $sectionStart = $index
            continue
        }
        if ($sectionStart -ge 0 -and $Lines[$index] -match '^\s*\[[^]]+\]\s*$') {
            $sectionEnd = $index
            break
        }
    }
    if ($sectionStart -lt 0) {
        if ($Lines.Count -gt 0 -and $Lines[$Lines.Count - 1].Trim()) { $Lines.Add('') }
        $Lines.Add('[mysqld]')
        $sectionStart = $Lines.Count - 1
        $sectionEnd = $Lines.Count
    }

    $pattern = '^\s*' + [regex]::Escape($Key) + '\s*='
    for ($index = $sectionStart + 1; $index -lt $sectionEnd; $index++) {
        if ($Lines[$index] -match $pattern) {
            $Lines[$index] = "$Key=$Value"
            return
        }
    }
    $Lines.Insert($sectionEnd, "$Key=$Value")
}

$service = Get-DatabaseService $Engine
if (-not $service) { throw "No installed $Engine Windows service was found." }

$process = if ($service.ProcessId) { Get-CimInstance Win32_Process -Filter "ProcessId=$($service.ProcessId)" } else { $null }
$executable = if ($process -and $process.ExecutablePath) { $process.ExecutablePath } else { $null }
if (-not $executable) {
    $match = [regex]::Match($service.PathName, '^(?:"([^"]+)"|([^\s]+))')
    $executable = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
    if (-not $executable.EndsWith('.exe')) { $executable += '.exe' }
}
if (-not (Test-Path -LiteralPath $executable)) { throw "Database executable was not found at $executable" }

$defaultsMatch = [regex]::Match($service.PathName, '(?i)--defaults-file(?:=|\s+)(?:"([^"]+)"|([^\s]+))')
$configPath = if ($defaultsMatch.Success) {
    if ($defaultsMatch.Groups[1].Success) { $defaultsMatch.Groups[1].Value } else { $defaultsMatch.Groups[2].Value }
} else {
    Join-Path (Split-Path (Split-Path $executable -Parent) -Parent) 'my.ini'
}

$lines = [System.Collections.Generic.List[string]]::new()
if (Test-Path -LiteralPath $configPath) {
    foreach ($line in [IO.File]::ReadAllLines($configPath)) { $lines.Add($line) }
    $backup = "$configPath.manager-backup"
    if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $configPath -Destination $backup }
}
Set-ServerOption $lines 'bind-address' '127.0.0.1'
if ($Engine -eq 'mysql') { Set-ServerOption $lines 'mysqlx-bind-address' '127.0.0.1' }

$parent = Split-Path $configPath -Parent
if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
[IO.File]::WriteAllLines($configPath, $lines, [Text.UTF8Encoding]::new($false))

Restart-Service -Name $service.Name -Force
$running = Get-Service -Name $service.Name
$running.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
Start-Sleep -Seconds 2

$refreshed = Get-CimInstance Win32_Service -Filter "Name='$($service.Name.Replace("'", "''"))'"
$listeners = @(Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -eq $refreshed.ProcessId })
$external = @($listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') })
if ($external.Count -gt 0) {
    $addresses = ($external | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" }) -join ', '
    throw "$Engine still has non-loopback listeners after restart: $addresses"
}

Write-Output "[security] $Engine service $($service.Name) is bound to loopback only."
Write-Output "[security] Configuration: $configPath"
foreach ($listener in $listeners | Sort-Object LocalPort) {
    Write-Output "[verify] $($listener.LocalAddress):$($listener.LocalPort)"
}
