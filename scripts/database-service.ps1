# Shared by setup and the loopback verifier. A client on PATH is not a server.
function Get-DatabaseServiceExecutable([string]$CommandLine) {
    $match = [regex]::Match($CommandLine, '^\s*(?:"([^"]+\.exe)"|(.+?\.exe))(?:\s|$)', 'IgnoreCase')
    if (-not $match.Success) { return $null }
    if ($match.Groups[1].Success) { return $match.Groups[1].Value }
    return $match.Groups[2].Value
}

function Select-DatabaseService([string]$Engine, [object[]]$Services, [string]$ServiceName) {
    $matches = @($Services | Where-Object {
        $executable = Get-DatabaseServiceExecutable $_.PathName
        $binaryName = if ($executable) { [IO.Path]::GetFileName($executable) } else { '' }
        $isServer = $binaryName -match '^(mysqld|mariadbd)\.exe$'
        $isMariaDb = ($_.Name + ' ' + $_.DisplayName + ' ' + $executable) -match '(?i)maria'
        $isServer -and (($Engine -eq 'mariadb') -eq $isMariaDb) -and (-not $ServiceName -or $_.Name -eq $ServiceName)
    })
    if ($matches.Count -gt 1) {
        throw ('Multiple ' + $Engine + ' services were found (' + (($matches | ForEach-Object Name) -join ', ') + '). Specify -ServiceName to select one.')
    }
    if ($matches.Count -eq 1) { return $matches[0] }
    return $null
}

function Get-DatabaseService([string]$Engine, [string]$ServiceName) {
    return Select-DatabaseService $Engine @(Get-CimInstance Win32_Service) $ServiceName
}

function Find-MySqlServerExecutable {
    $candidates = [System.Collections.Generic.List[string]]::new()
    foreach ($command in @(Get-Command mysqld.exe -All -ErrorAction SilentlyContinue)) { $candidates.Add($command.Source) }
    foreach ($command in @(Get-Command mysql.exe -All -ErrorAction SilentlyContinue)) {
        $candidates.Add((Join-Path (Split-Path $command.Source -Parent) 'mysqld.exe'))
    }
    $toolsRoot = if ($env:ChocolateyToolsLocation) { $env:ChocolateyToolsLocation } else { 'C:\tools' }
    $candidates.Add((Join-Path $toolsRoot 'mysql\current\bin\mysqld.exe'))
    if ($env:ProgramFiles) {
        $mysqlRoot = Join-Path $env:ProgramFiles 'MySQL'
        if (Test-Path -LiteralPath $mysqlRoot -PathType Container) {
            foreach ($directory in @(Get-ChildItem -LiteralPath $mysqlRoot -Directory)) {
                $candidates.Add((Join-Path $directory.FullName 'bin\mysqld.exe'))
            }
        }
    }
    $found = @($candidates | Select-Object -Unique | Where-Object {
        if (-not (Test-Path -LiteralPath $_ -PathType Leaf) -or $_ -match '(?i)maria') { return $false }
        $version = @(& $_ --no-defaults --version 2>$null) -join ' '
        $LASTEXITCODE -eq 0 -and $version -match 'MySQL' -and $version -notmatch 'MariaDB'
    })
    if ($found.Count -gt 1) { throw 'Multiple MySQL server installations were found. Specify -ServerExecutable and -DefaultsFile to select the installation to repair.' }
    if ($found.Count -eq 1) { return $found[0] }
    return $null
}

function Get-DatabaseDefaultsFile([string]$Executable, [string]$CommandLine, [string]$ExplicitPath) {
    if ($ExplicitPath) { $configPath = $ExplicitPath }
    else {
        $match = [regex]::Match($CommandLine, '(?i)--defaults-file(?:=|\s+)(?:"([^"]+)"|([^\s]+))')
        if ($match.Success) {
            $configPath = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
        } else {
            $baseDirectory = Split-Path (Split-Path $Executable -Parent) -Parent
            $candidates = @((Join-Path $baseDirectory 'my.ini'), (Join-Path $baseDirectory 'my.cnf'), (Join-Path $baseDirectory 'data\my.ini'))
            $existing = @($candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
            if ($existing.Count -ne 1) { throw "Could not identify one existing MySQL/MariaDB configuration for $Executable. Specify -DefaultsFile; existing data has not been changed." }
            $configPath = $existing[0]
        }
    }
    if (-not [IO.Path]::IsPathRooted($configPath) -or -not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "Database configuration does not exist at an absolute path: $configPath" }
    return (Get-Item -LiteralPath $configPath).FullName
}

function Read-DatabaseOptions([string]$Executable, [string]$ConfigPath, [string]$ServiceName) {
    $reader = Join-Path (Split-Path $Executable -Parent) 'my_print_defaults.exe'
    if (-not (Test-Path -LiteralPath $reader -PathType Leaf)) { throw "Database configuration reader was not found: $reader" }
    $groups = @('mysqld')
    if ($ServiceName -and $ServiceName -ne 'MySQL') { $groups += $ServiceName }
    $output = @(& $reader ("--defaults-file=$ConfigPath") @groups)
    if ($LASTEXITCODE -ne 0) { throw "Could not read database configuration: $ConfigPath" }
    $options = @{}
    foreach ($line in $output) {
        if ($line -match '^--([^=]+)=(.*)$') { $options[$matches[1]] = $matches[2] }
    }
    return $options
}

function Get-MySqlDataState([string]$DataDirectory) {
    if (-not $DataDirectory -or -not [IO.Path]::IsPathRooted($DataDirectory)) { throw 'Repair requires an explicit absolute datadir in the existing configuration.' }
    $resolved = [IO.Path]::GetFullPath($DataDirectory).TrimEnd('\')
    if ($resolved -eq [IO.Path]::GetPathRoot($resolved).TrimEnd('\')) { throw 'A drive root cannot be a MySQL data directory.' }
    if (Test-Path -LiteralPath $resolved) {
        $item = Get-Item -LiteralPath $resolved -Force
        if (-not $item.PSIsContainer) { throw 'The MySQL data directory path is not a directory.' }
        $contents = @(Get-ChildItem -LiteralPath $resolved -Force)
        if ($contents.Count -gt 0) {
            if ((Test-Path -LiteralPath (Join-Path $resolved 'mysql.ibd') -PathType Leaf) -or (Test-Path -LiteralPath (Join-Path $resolved 'mysql') -PathType Container)) { return 'existing' }
            throw 'The MySQL data directory contains files but no recognized system database. It will not be initialized or overwritten. Inspect the previous MySQL initialization log.'
        }
    }
    # Do not initialize through a junction whose destination may be another database.
    $ancestor = $resolved
    while ($ancestor) {
        if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Automatic initialization through a linked data directory is not supported.' }
        $ancestor = Split-Path $ancestor -Parent
    }
    return 'empty'
}

function Set-DatabaseServerOption([System.Collections.Generic.List[string]]$Lines, [string]$Section, [string]$Key, [string]$Value) {
    $inSection = $false
    $updated = $false
    for ($index = 0; $index -lt $Lines.Count; $index++) {
        if ($Lines[$index] -match '^\s*\[([^]]+)\]\s*$') { $inSection = $matches[1] -eq $Section }
        if ($inSection -and $Lines[$index] -match ('^\s*' + [regex]::Escape($Key) + '\s*=')) {
            $Lines[$index] = "$Key=$Value"
            $updated = $true
        }
    }
    if (-not $updated) {
        $Lines.Add('')
        $Lines.Add("[$Section]")
        $Lines.Add("$Key=$Value")
    }
}

function Invoke-DatabaseNative([string]$Executable, [string[]]$Arguments, [string]$Label) {
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $Executable @Arguments 2>&1)
        $nativeExitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    foreach ($line in $output) { Write-Host ([string]$line) }
    if ($nativeExitCode -ne 0) { throw "$Label failed with exit code $nativeExitCode" }
}

function Assert-DatabaseListeners([object[]]$Listeners, [int]$ExpectedPort) {
    if ($Listeners.Count -eq 0) { throw 'The database service has no TCP listener.' }
    if (@($Listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1','::1') }).Count) { throw 'The database service still has non-loopback listeners.' }
    if ($ExpectedPort -and -not @($Listeners | Where-Object { $_.LocalPort -eq $ExpectedPort }).Count) { throw "The database service is not listening on its configured port $ExpectedPort." }
}

function Get-DatabaseListenerProcessIds([int]$ServiceProcessId, [string]$Executable, [object[]]$Processes) {
    # Current MySQL Windows versions can run a monitor as the service process
    # and own their sockets in a child mysqld. Scope verification to this tree.
    $owned = [System.Collections.Generic.HashSet[int]]::new()
    $owned.Add($ServiceProcessId) | Out-Null
    do {
        $added = $false
        foreach ($process in $Processes) {
            if ($owned.Contains([int]$process.ParentProcessId) -and $process.ExecutablePath -and
                [IO.Path]::GetFullPath($process.ExecutablePath) -eq [IO.Path]::GetFullPath($Executable)) {
                if ($owned.Add([int]$process.ProcessId)) { $added = $true }
            }
        }
    } while ($added)
    return @($owned)
}
