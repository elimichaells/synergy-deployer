[CmdletBinding()]
param([string]$OutputDirectory, [string]$Version, [switch]$Offline)

$ErrorActionPreference = 'Stop'
# Windows PowerShell can inherit a PowerShell 7-only module search path.
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + ';' + $env:PSModulePath
$root = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $root 'packages' }
if (-not $Version) { $Version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version }
$name = $(if ($Offline) { 'manager-windows-offline-' } else { 'manager-windows-' }) + $Version + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
$staging = Join-Path $env:TEMP $name
$archive = Join-Path $OutputDirectory ($name + '.zip')
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$resolvedTemp = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
$resolvedStaging = [IO.Path]::GetFullPath($staging)
if (-not $resolvedStaging.StartsWith($resolvedTemp,[StringComparison]::OrdinalIgnoreCase)) { throw 'Packaging staging path escaped the Windows temporary directory' }
Remove-Item -LiteralPath $resolvedStaging -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $staging | Out-Null

Push-Location $root
try {
    $sourceCommit = & git rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Packaging requires a Git source checkout' }
    $sourceDirty = [bool](@(& git status --porcelain).Count)
    if ($sourceDirty) { throw 'Formal release packaging requires a clean source checkout. Commit and verify the reviewed source first.' }
    $packageVersion = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
    if ($Version -ne $packageVersion) { throw 'Package version must match package.json' }
    $sourceFiles = @(& git ls-files --cached --others --exclude-standard)
    if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate Manager source files' }
    $blocked = @('.env.local','pm2_jlist.json','pm2_list.json','pm2_fresh.json','manager_logs.txt','manager_logs_utf8.txt','build.log','_prod_deploy_log.txt','tsconfig.tsbuildinfo')
    foreach ($relative in $sourceFiles) {
        if ($blocked -contains $relative -or $relative -like 'packages/*' -or $relative -match '(^|/)\.next[^/]*(/|$)' -or $relative -like 'node_modules/*' -or $relative -like 'installer/ManagerSetup/Assets/*' -or $relative -like 'installer/ManagerSetup/bin/*' -or $relative -like 'installer/ManagerSetup/obj/*') { continue }
        if ($relative -match '(^|/)\.env($|\.)' -and $relative -notmatch '\.example$') { continue }
        $source = Join-Path $root $relative
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
        $target = Join-Path $staging $relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        Copy-Item -LiteralPath $source -Destination $target
    }
    Copy-Item (Join-Path $root 'installer\manager-install.example.json') (Join-Path $staging 'manager-install.json')
    @{version=$Version;sourceCommit=$sourceCommit;sourceDirty=$sourceDirty;offline=[bool]$Offline} |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $staging 'release-source.json') -Encoding UTF8
    @'
Manager Windows Server Package

No separately installed packages or services are required. The setup launcher
installs Node.js LTS, the latest compatible npm, Git, PM2, Caddy, PostgreSQL,
and the optional runtimes and database engines selected in the configuration.
PostgreSQL is split into a Manager control cluster on port 5432 and a
localhost-only application cluster on port 5433. Project databases and users
are provisioned on the application cluster from the Manager interface.

1. Double-click setup.cmd for the interactive, self-elevating wizard.
2. For unattended installation, edit manager-install.json and run:
   setup.cmd -Unattended
3. Preview an unattended installation without changing the host:
   setup.cmd -Unattended -Plan

An internet connection and a supported 64-bit Windows Server installation are
required. Prefer MANAGER_INSTALL_* environment variables for passwords.
'@ | Set-Content (Join-Path $staging 'INSTALL.txt') -Encoding UTF8
} finally { Pop-Location }

if ($Offline) {
    $offlineConfigPath = Join-Path $staging 'manager-install.json'
    $offlineConfig = Get-Content -LiteralPath $offlineConfigPath -Raw | ConvertFrom-Json
    $offlineConfig | Add-Member -NotePropertyName OfflineInstall -NotePropertyValue $true -Force
    $offlineConfig.ManagerAccessMode = 'local'
    $offlineConfig.ManagerDomain = 'deploy.institution.local'
    $offlineConfig.InstallLatestNpm = $false
    $offlineConfig | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $offlineConfigPath -Encoding UTF8
    & node.exe (Join-Path $PSScriptRoot 'build-offline-bundle.cjs') --source $staging --output (Join-Path $staging 'offline') --cache (Join-Path $root 'packages\offline-cache')
    if ($LASTEXITCODE -ne 0) { throw 'Offline dependency packaging failed' }
    @'
Manager offline Windows x64 package
All Manager dependencies and the production app are bundled. No Chocolatey,
npm registry, GitHub or build downloads are required on the target server.
Run setup.cmd and select institution/local network access for internal HTTPS.
PostgreSQL 17, Pgweb and the default language runtimes are included. MySQL,
MariaDB, MongoDB, SQL Server Express and phpMyAdmin packages are retained for
offline installation from the dashboard. Redis uses an existing server.
Project builds need their own
vendored dependencies or internal package registries.
See docs/offline-installation.md for installation and reboot verification.
'@ | Set-Content -LiteralPath (Join-Path $staging 'INSTALL.txt') -Encoding UTF8
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($staging,$archive,[IO.Compression.CompressionLevel]::Optimal,$false)
$hash = (Get-FileHash $archive -Algorithm SHA256).Hash
@{file=[IO.Path]::GetFileName($archive);sha256=$hash;version=$Version;sourceCommit=$sourceCommit;sourceDirty=$sourceDirty;offline=[bool]$Offline;createdAt=(Get-Date).ToUniversalTime().ToString('o')} |
    ConvertTo-Json | Set-Content ($archive + '.sha256.json') -Encoding UTF8
Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
Write-Host ('Package: ' + $archive) -ForegroundColor Green
Write-Host ('SHA256: ' + $hash) -ForegroundColor Green
