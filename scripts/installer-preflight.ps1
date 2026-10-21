# Read-only checks shared by the GUI and command-line installer.
function Get-ManagerPostgresPackage([int]$WindowsBuild) {
    # EDB tests PostgreSQL 17 on Server 2019, and 18 on Server 2022/2025.
    if ($WindowsBuild -lt 20348) { return 'postgresql17' }
    return 'postgresql18'
}

function Assert-ManagerInstallPaths([string]$ManagerRoot, [string]$WebRoot, [string]$PackageRoot) {
    foreach ($path in @($ManagerRoot, $WebRoot)) {
        if ($path -notmatch '^[A-Za-z]:[\\/]' -or $path -match '[\r\n"]') {
            throw 'ManagerRoot and WebRoot must be absolute local Windows paths.'
        }
    }
    $manager = [IO.Path]::GetFullPath($ManagerRoot).TrimEnd('\', '/')
    $web = [IO.Path]::GetFullPath($WebRoot).TrimEnd('\', '/')
    $source = [IO.Path]::GetFullPath($PackageRoot).TrimEnd('\', '/')
    if ($manager -eq [IO.Path]::GetPathRoot($manager).TrimEnd('\', '/') -or
        $manager -eq $web -or $web.StartsWith($manager + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'ManagerRoot must be a dedicated application directory, not a drive root or the WebRoot directory.'
    }
    if ($manager -ne $source -and ($source.StartsWith($manager + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $manager.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase))) {
        throw 'The package directory and ManagerRoot must not be nested inside one another.'
    }
    if (Test-Path -LiteralPath (Join-Path $manager '.env.local')) {
        throw 'ManagerRoot already contains .env.local. Setup is for new installations; use the upgrade or recovery procedure to preserve existing encryption keys and credentials.'
    }
}

function Assert-ManagerInstallPorts([int]$ManagerPort, [int]$DbPort, [bool]$InstallApplicationPostgres,
    [int]$AppDbPort, [bool]$InstallPgweb, [bool]$InstallPhpMyAdmin) {
    $ports = @($ManagerPort, $DbPort)
    if ($InstallApplicationPostgres) { $ports += $AppDbPort }
    foreach ($port in $ports) {
        if ($port -lt 1 -or $port -gt 65535) { throw 'Configured ports must be between 1 and 65535.' }
    }
    $reserved = @(80, 443, $DbPort)
    if ($InstallApplicationPostgres) { $reserved += $AppDbPort }
    if ($InstallPgweb) { $reserved += 8432 }
    if ($InstallPhpMyAdmin) { $reserved += 8433 }
    if ($reserved -contains $ManagerPort) { throw 'ManagerPort conflicts with a selected database, web client, or Caddy port.' }
    if ($InstallApplicationPostgres -and $AppDbPort -eq $DbPort) { throw 'AppDbPort must differ from the Manager control database port.' }
    $requiredFree = @($ManagerPort, 80, 443)
    if ($InstallPgweb) { $requiredFree += 8432 }
    if ($InstallPhpMyAdmin) { $requiredFree += 8433 }
    foreach ($port in $requiredFree) {
        if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
            throw ('TCP port ' + $port + ' is already in use. Stop or reconfigure the conflicting service before installation.')
        }
    }
}
