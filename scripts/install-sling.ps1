[CmdletBinding()]
param(
    [string]$Version = '1.5.23',
    [string]$InstallDirectory = 'C:\web\tools\sling',
    [switch]$Latest
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-','')
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

if ($Latest) {
    $release = Invoke-RestMethod 'https://api.github.com/repos/slingdata-io/sling-cli/releases/latest' -Headers @{ 'User-Agent' = 'Manager-Runtime-Updater' }
    $Version = ([string]$release.tag_name).TrimStart('v')
    if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'The latest Sling release tag is invalid' }
    Write-Host ('Latest Sling release: ' + $Version)
}
$archiveName = 'sling_windows_amd64.tar.gz'
$baseUrl = 'https://github.com/slingdata-io/sling-cli/releases/download/v' + $Version
$archivePath = Join-Path $env:TEMP ($archiveName + '.' + [guid]::NewGuid().ToString('N'))
$checksumPath = Join-Path $env:TEMP ('sling-checksums.' + [guid]::NewGuid().ToString('N') + '.txt')
$staging = Join-Path $env:TEMP ('manager-sling-' + [guid]::NewGuid().ToString('N'))

try {
    Invoke-WebRequest ($baseUrl + '/' + $archiveName) -OutFile $archivePath -UseBasicParsing
    Invoke-WebRequest ($baseUrl + '/windows.amd64.checksums.txt') -OutFile $checksumPath -UseBasicParsing
    $checksumLine = (Get-Content -LiteralPath $checksumPath -Raw).Trim()
    if ($checksumLine -notmatch '^([a-fA-F0-9]{64})\s+\*?sling_windows_amd64\.tar\.gz$') {
        throw 'Sling checksum manifest is invalid'
    }
    $expected = $Matches[1].ToUpperInvariant()
    $actual = Get-Sha256Hex $archivePath
    if ($actual -ne $expected) { throw 'Sling archive failed SHA-256 verification' }

    New-Item -ItemType Directory -Force -Path $staging,$InstallDirectory | Out-Null
    $tarPath = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (-not (Test-Path -LiteralPath $tarPath)) { throw 'Windows tar.exe is not available' }
    & $tarPath -xzf $archivePath -C $staging
    if ($LASTEXITCODE -ne 0) { throw 'Sling archive extraction failed' }
    $executable = Get-ChildItem -LiteralPath $staging -Filter 'sling.exe' -File -Recurse | Select-Object -First 1
    if (-not $executable) { throw 'sling.exe was not found in the verified archive' }
    Copy-Item -LiteralPath $executable.FullName -Destination (Join-Path $InstallDirectory 'sling.exe') -Force
    $env:AWS_EC2_METADATA_DISABLED = 'true'
    & (Join-Path $InstallDirectory 'sling.exe') --version
    if ($LASTEXITCODE -ne 0) { throw 'Sling runtime verification failed' }
    Write-Host ('Sling ' + $Version + ' installed and verified at ' + $InstallDirectory) -ForegroundColor Green
} finally {
    Remove-Item -LiteralPath $archivePath,$checksumPath -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $staging) {
        $resolved = [IO.Path]::GetFullPath($staging)
        $tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
        if ($resolved.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
}
