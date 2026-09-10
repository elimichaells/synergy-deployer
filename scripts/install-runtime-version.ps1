[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('node','php','go')]
    [string]$Runtime,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version,
    [string]$InstallRoot = 'C:\web\tools'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$tempRoot = Join-Path $env:TEMP ('manager-runtime-' + [guid]::NewGuid().ToString('N'))

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

function Get-VerifiedDownload {
    param([string]$Url,[string]$Destination,[string]$ExpectedSha256)
    Write-Host ('[download] ' + $Url)
    $client = [Net.Http.HttpClient]::new()
    $response = $client.GetAsync($Url,[Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    $response.EnsureSuccessStatusCode() | Out-Null
    $total = $response.Content.Headers.ContentLength
    $input = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $output = [IO.File]::Open($Destination,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {
        $buffer = New-Object byte[] (1024 * 1024)
        $received = 0L
        $reported = -1
        while (($read = $input.Read($buffer,0,$buffer.Length)) -gt 0) {
            $output.Write($buffer,0,$read)
            $received += $read
            if ($total) {
                $percent = [Math]::Floor(($received * 100) / $total)
                if ($percent -ge ($reported + 5) -or $percent -eq 100) {
                    Write-Host ('[download] ' + $percent + '% (' + [Math]::Round($received / 1MB,1) + ' MB)')
                    $reported = $percent
                }
            }
        }
    } finally {
        $output.Dispose(); $input.Dispose(); $response.Dispose(); $client.Dispose()
    }
    $actual = (Get-Sha256Hex $Destination).ToLowerInvariant()
    if ($actual -ne $ExpectedSha256.ToLowerInvariant()) { throw 'Downloaded archive failed SHA-256 verification' }
    Write-Host '[verify] SHA-256 passed'
}

function Install-Archive {
    param([string]$Archive,[string]$Target,[string]$InnerDirectory)
    $staging = Join-Path $tempRoot 'expanded'
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    Write-Host '[extract] Expanding the verified archive. Large SDKs can take several minutes on Windows.'
    Expand-Archive -LiteralPath $Archive -DestinationPath $staging -Force
    $source = if ($InnerDirectory) { Join-Path $staging $InnerDirectory } else { $staging }
    if (!(Test-Path -LiteralPath $source)) { throw ('Expected archive directory was not found: ' + $InnerDirectory) }
    New-Item -ItemType Directory -Force -Path (Split-Path $Target -Parent) | Out-Null
    if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
    Move-Item -LiteralPath $source -Destination $Target
    Write-Host ('[extract] Installed files at ' + $Target)
}

try {
    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
    if ($Runtime -eq 'node') {
        $release = 'v' + $Version
        $name = 'node-' + $release + '-win-x64.zip'
        $base = 'https://nodejs.org/dist/' + $release
        $checksums = (Invoke-WebRequest ($base + '/SHASUMS256.txt') -UseBasicParsing).Content
        $line = ($checksums -split "`n" | Where-Object { $_ -match ('\s' + [regex]::Escape($name) + '$') } | Select-Object -First 1)
        if ($line -notmatch '^([a-fA-F0-9]{64})\s+') { throw 'Node.js checksum entry was not found' }
        $archive = Join-Path $tempRoot $name
        Get-VerifiedDownload ($base + '/' + $name) $archive $Matches[1]
        $target = Join-Path $InstallRoot ('node\' + $Version)
        Install-Archive $archive $target ('node-' + $release + '-win-x64')
        & (Join-Path $target 'node.exe') --version
        & (Join-Path $target 'npm.cmd') --version
    } elseif ($Runtime -eq 'php') {
        $catalog = Invoke-RestMethod 'https://windows.php.net/downloads/releases/releases.json'
        $release = $catalog.PSObject.Properties.Value | Where-Object { $_.version -eq $Version } | Select-Object -First 1
        if (!$release) { throw ('PHP ' + $Version + ' was not found in the official Windows release catalog') }
        $build = $release.PSObject.Properties | Where-Object { $_.Name -match '^nts-vs\d+-x64$' } | Select-Object -First 1
        if (!$build -or !$build.Value.zip) { throw 'A supported PHP NTS x64 build was not found' }
        $name = $build.Value.zip.path
        $archive = Join-Path $tempRoot $name
        Get-VerifiedDownload ('https://windows.php.net/downloads/releases/' + $name) $archive $build.Value.zip.sha256
        $target = Join-Path $InstallRoot ('php\' + $Version)
        Install-Archive $archive $target ''
        Copy-Item (Join-Path $target 'php.ini-production') (Join-Path $target 'php.ini') -Force
        $ini = Get-Content (Join-Path $target 'php.ini') -Raw
        $ini = $ini -replace '(?m)^\s*;?\s*extension_dir\s*=.*$','extension_dir="ext"'
        foreach ($extension in @('bcmath','curl','fileinfo','gd','gmp','intl','mbstring','mysqli','openssl','pdo_mysql','pdo_pgsql','sodium','zip')) {
            $dll = Join-Path $target ('ext\php_' + $extension + '.dll')
            if (Test-Path -LiteralPath $dll) {
                $ini = $ini -replace ('(?m)^\s*;\s*extension\s*=\s*' + [regex]::Escape($extension) + '\s*$'),('extension=' + $extension)
            }
        }
        Set-Content (Join-Path $target 'php.ini') $ini -Encoding ASCII
        & (Join-Path $target 'php.exe') --version
        & (Join-Path $target 'php.exe') -r "if (!extension_loaded('openssl')) { exit(2); }"
    } else {
        $catalog = Invoke-RestMethod 'https://go.dev/dl/?mode=json&include=all'
        $release = $catalog | Where-Object { $_.version -eq ('go' + $Version) } | Select-Object -First 1
        $file = $release.files | Where-Object { $_.os -eq 'windows' -and $_.arch -eq 'amd64' -and $_.kind -eq 'archive' } | Select-Object -First 1
        if (!$file) { throw ('Go ' + $Version + ' Windows x64 archive was not found') }
        $archive = Join-Path $tempRoot $file.filename
        Get-VerifiedDownload ('https://go.dev/dl/' + $file.filename) $archive $file.sha256
        $target = Join-Path $InstallRoot ('go\' + $Version)
        Install-Archive $archive $target 'go'
        & (Join-Path $target 'bin\go.exe') version
    }
    Write-Host ('[complete] ' + $Runtime + ' ' + $Version + ' installed side by side')
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        $resolved = [IO.Path]::GetFullPath($tempRoot)
        $temp = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
        if ($resolved.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
