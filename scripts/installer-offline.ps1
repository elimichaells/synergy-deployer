# Offline provisioning deliberately has no network or package-manager fallback.
function Get-ManagerPgpassEntry([string]$DatabaseHost, [int]$Port, [string]$User, [string]$Password) {
    $fields = @($DatabaseHost,[string]$Port,'*',$User,$Password)
    if (@($fields | Where-Object { $_ -match '[\r\n]' }).Count) { throw 'PostgreSQL connection fields must not contain line breaks' }
    return (($fields | ForEach-Object { $_.Replace('\','\\').Replace(':','\:') }) -join ':')
}

function Get-ManagerOfflinePath([string]$Root, [string]$Relative) {
    if (-not $Relative -or $Relative -match '[:\\]' -or $Relative.StartsWith('/') -or @($Relative.Split('/') | Where-Object { $_ -in @('..','.','') }).Count) {
        throw ('Invalid offline bundle path: ' + $Relative)
    }
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $resolved = [IO.Path]::GetFullPath((Join-Path $Root $Relative))
    if (-not $resolved.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { throw 'Offline bundle path escaped its root' }
    return $resolved
}

function Read-ManagerOfflineBundle([string]$Root, [string]$Version, [string]$LockHash, [string[]]$Runtimes, [string[]]$Engines, [bool]$Pgweb) {
    $manifestPath = Join-Path $Root 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'The offline dependency bundle is missing. Use an offline setup build; no downloads will be attempted.' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.architecture -ne 'win-x64' -or $manifest.managerVersion -ne $Version -or $manifest.packageLockSha256 -ne $LockHash) {
        throw 'The offline bundle does not match this Manager version, dependency lock, or Windows architecture'
    }
    if ([Environment]::OSVersion.Version.Build -lt $manifest.minimumWindowsBuild) { throw 'The offline bundle requires Windows Server 2019 / Windows 10 build 17763 or newer' }
    if (@($Engines).Count) { throw ('This offline bundle includes PostgreSQL. Optional database installers are not bundled: ' + ($Engines -join ', ') + '. Deselect these engines; existing institution database servers can be connected after setup.') }
    $required = @('application','node','git','caddy','postgresql','pm2','sling','vcredist') + @($Runtimes)
    if ($Runtimes -contains 'composer') { $required += 'php' }
    if ($Pgweb) { $required += 'pgweb' }
    $ids = @{}
    foreach ($item in $manifest.artifacts) {
        if ($item.id -notin @('application','node','git','caddy','postgresql','pm2','sling','vcredist','go','php','composer','python','pgweb') -or $ids.ContainsKey($item.id)) { throw 'Unknown or duplicate offline component' }
        if ($item.sha256 -notmatch '^[A-Fa-f0-9]{64}$' -or [long]$item.bytes -le 0) { throw ('Invalid offline checksum or size: ' + $item.id) }
        $file = Get-ManagerOfflinePath $Root $item.file
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw ('Offline component is missing: ' + $item.id) }
        if ((Get-Item -LiteralPath $file).Length -ne [long]$item.bytes -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $item.sha256) { throw ('Offline component failed SHA-256 verification: ' + $item.id) }
        $ids[$item.id] = $item
    }
    foreach ($id in $required | Select-Object -Unique) { if (-not $ids.ContainsKey($id)) { throw ('Offline component is not bundled: ' + $id) } }
    return [pscustomobject]@{ Root=$Root; Manifest=$manifest; Items=$ids; Required=@($required | Select-Object -Unique); Hash=(Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash }
}

function Expand-ManagerOfflineArchive([string]$Archive, [string]$Destination) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem,System.IO.Compression
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        # Validate every entry before writing any file (including Windows ADS and symlinks).
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\','/').TrimEnd('/')
            if (-not $name) { continue }
            $null = Get-ManagerOfflinePath $Destination $name
            if ((($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'Offline archives must not contain symbolic links' }
        }
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\','/').TrimEnd('/')
            if (-not $name) { continue }
            $target = Get-ManagerOfflinePath $Destination $name
            if ($entry.FullName.EndsWith('/') -or $entry.FullName.EndsWith('\')) { New-Item -ItemType Directory -Force -Path $target | Out-Null; continue }
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
        }
    } finally { $zip.Dispose() }
}

function Invoke-ManagerOfflineSetup([string]$File, [string[]]$Arguments, [int[]]$SuccessCodes = @(0,3010)) {
    $process = Start-Process -FilePath $File -ArgumentList $Arguments -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -notin $SuccessCodes) { throw ('Bundled installer failed: ' + [IO.Path]::GetFileName($File) + ' (exit ' + $process.ExitCode + ')') }
    if ($process.ExitCode -eq 3010) { Write-Warning 'A bundled prerequisite requests a Windows restart after installation.' }
}

function Install-ManagerOfflineTools($Bundle, [string]$ToolsRoot) {
    New-Item -ItemType Directory -Force -Path $ToolsRoot | Out-Null
    & icacls.exe $ToolsRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' '*S-1-5-20:(OI)(CI)RX' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to secure bundled runtime directory' }
    $vc = Get-ManagerOfflinePath $Bundle.Root $Bundle.Items['vcredist'].file
    Invoke-ManagerOfflineSetup $vc @('/install','/quiet','/norestart') @(0,3010,1638)
    $paths = @{}
    foreach ($id in $Bundle.Required) {
        if ($id -in @('application','vcredist','python')) { continue }
        $item = $Bundle.Items[$id]
        $destination = Join-Path $ToolsRoot ($id + '-' + $item.sha256.Substring(0,12).ToLowerInvariant())
        $marker = Join-Path $destination '.manager-offline-complete'
        if (-not (Test-Path -LiteralPath $marker)) {
            if (Test-Path -LiteralPath $destination) { throw ('Incomplete runtime directory exists. Move it aside before retrying: ' + $destination) }
            Expand-ManagerOfflineArchive (Get-ManagerOfflinePath $Bundle.Root $item.file) $destination
            Set-Content -LiteralPath $marker -Value $item.sha256 -Encoding ASCII
        }
        $paths[$id] = $destination
        Write-Host ('[PASS] Bundled ' + $id + ': ' + $item.version)
    }
    if ($Bundle.Required -contains 'python') {
        $item = $Bundle.Items['python']
        $destination = Join-Path $ToolsRoot ('python-' + $item.version)
        if (-not (Test-Path -LiteralPath (Join-Path $destination 'python.exe'))) {
            Invoke-ManagerOfflineSetup (Get-ManagerOfflinePath $Bundle.Root $item.file) @('/quiet','InstallAllUsers=1','Include_test=0','Include_doc=0','Include_launcher=1','InstallLauncherAllUsers=1','Include_pip=1','PrependPath=0',('TargetDir="' + $destination + '"'))
        }
        $paths['python'] = $destination
    }
    if ($paths.ContainsKey('php')) {
        $ini = Join-Path $paths['php'] 'php.ini'
        if (-not (Test-Path -LiteralPath $ini)) {
            $settings = (Get-Content -LiteralPath (Join-Path $paths['php'] 'php.ini-production') -Raw).Replace(';extension_dir = "ext"',('extension_dir = "' + (Join-Path $paths['php'] 'ext').Replace('\','/') + '"'))
            foreach ($extension in @('curl','fileinfo','mbstring','openssl','pdo_mysql','pdo_pgsql','pgsql','mysqli','zip')) { $settings = $settings -replace ('(?m)^;extension=' + $extension + '\s*$'),('extension=' + $extension) }
            Set-Content -LiteralPath $ini -Value $settings -Encoding ASCII
        }
    }
    $entries = @()
    foreach ($id in $paths.Keys) {
        $bin = if ($id -in @('postgresql','go')) { 'bin' } elseif ($id -eq 'git') { 'cmd' } else { '' }
        $entries += if ($bin) { Join-Path $paths[$id] $bin } else { $paths[$id] }
    }
    # Save machine paths as well as the explicit PM2 startup PATH, so SYSTEM does not
    # depend on the installing administrator's profile after reboot.
    $machinePath = [Environment]::GetEnvironmentVariable('Path','Machine')
    $newPath = (($entries + @($machinePath -split ';') | Where-Object { $_ } | Select-Object -Unique) -join ';')
    [Environment]::SetEnvironmentVariable('Path',$newPath,'Machine')
    $env:Path = ($entries -join ';') + ';' + $env:Path
    $env:PG_BIN_PATH = Join-Path $paths['postgresql'] 'bin'
    return $paths
}

function Initialize-ManagerOfflineControlPostgres([string]$Bin, [string]$Data, [int]$Port, [string]$User, [string]$Password) {
    $serviceName = 'ManagerPostgreSQLControl'
    if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) { throw 'The Manager control PostgreSQL service already exists; preserve its data and credentials before retrying.' }
    if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { throw ('Control PostgreSQL port is already in use: ' + $Port + '. Deselect control database installation to use an existing server.') }
    if (Test-Path -LiteralPath $Data) { throw ('The control PostgreSQL directory already exists; it will not be initialized again: ' + $Data) }
    $passwordFile = Join-Path $env:TEMP ('manager-control-' + [guid]::NewGuid() + '.pw')
    [IO.File]::WriteAllText($passwordFile,$Password,[Text.UTF8Encoding]::new($false))
    & icacls.exe $passwordFile /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { Remove-Item -LiteralPath $passwordFile -Force; throw 'Failed to secure PostgreSQL password file' }
    try {
        Invoke-Native (Join-Path $Bin 'initdb.exe') @('-D',$Data,'-U',$User,'--encoding=UTF8','--auth-host=scram-sha-256','--auth-local=scram-sha-256',('--pwfile=' + $passwordFile)) 'Initialize offline control PostgreSQL'
    } finally { Remove-Item -LiteralPath $passwordFile -Force }
    Add-Content -LiteralPath (Join-Path $Data 'postgresql.conf') -Value ("`r`nlisten_addresses = '127.0.0.1'`r`nport = " + $Port + "`r`npassword_encryption = 'scram-sha-256'")
    & icacls.exe $Data /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-20:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to secure control PostgreSQL data directory' }
    Invoke-Native (Join-Path $Bin 'pg_ctl.exe') @('register','-N',$serviceName,'-D',$Data,'-U','NT AUTHORITY\NetworkService','-S','auto') 'Register control PostgreSQL service'
    Start-Service -Name $serviceName
    for ($attempt=0; $attempt -lt 30; $attempt++) {
        & (Join-Path $Bin 'pg_isready.exe') -h 127.0.0.1 -p $Port -d postgres 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { return }
        Start-Sleep -Seconds 1
    }
    throw 'Offline control PostgreSQL did not become ready'
}
