[CmdletBinding()]
param([switch]$Latest)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$installRoot = 'C:\web\tools\phpmyadmin'
$toolsRoot = [IO.Path]::GetFullPath('C:\web\tools')
$targetRoot = [IO.Path]::GetFullPath($installRoot)
if (-not $targetRoot.StartsWith($toolsRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid phpMyAdmin installation path' }

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Enable-PhpExtension([string]$IniPath, [string]$Extension) {
    $modules = @(cmd.exe /d /c "php.exe -m 2>NUL" | ForEach-Object { ([string]$_).Trim().ToLowerInvariant() })
    if ($modules -contains $Extension.ToLowerInvariant()) { return }
    $dll = Join-Path (Split-Path -Parent (Get-Command php.exe).Source) ('ext\php_' + $Extension + '.dll')
    if (-not (Test-Path -LiteralPath $dll)) { throw ('PHP extension is unavailable: ' + $Extension) }
    $content = Get-Content -LiteralPath $IniPath -Raw
    $pattern = '(?m)^;extension\s*=\s*' + [regex]::Escape($Extension) + '\s*$'
    if ($content -notmatch $pattern) { throw ('PHP extension is not configurable in ' + $IniPath + ': ' + $Extension) }
    $updated = ([regex]::new($pattern)).Replace($content, ('extension=' + $Extension), 1)
    Set-Content -LiteralPath $IniPath -Value $updated -Encoding ASCII
}

$phpVersion = (& php.exe -r "echo PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION;").Trim()
if ([version]$phpVersion -ge [version]'8.4') { throw 'phpMyAdmin 5.2 requires PHP 7.2 through 8.3. Select a compatible PHP runtime.' }
$iniOutput = @(& php.exe --ini)
$loadedLine = $iniOutput | Where-Object { $_ -match '^Loaded Configuration File:\s+(.+)$' } | Select-Object -First 1
if (-not $loadedLine) { throw 'The active PHP configuration file could not be located' }
$iniPath = ([regex]::Match($loadedLine, '^Loaded Configuration File:\s+(.+)$').Groups[1].Value).Trim()
if (-not (Test-Path -LiteralPath $iniPath)) { throw ('The active PHP configuration file does not exist: ' + $iniPath) }

$catalog = Invoke-RestMethod 'https://www.phpmyadmin.net/home_page/version.json'
$version = [string]$catalog.version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'The phpMyAdmin release catalog returned an invalid version' }
$archiveName = 'phpMyAdmin-' + $version + '-all-languages.zip'
$baseUrl = 'https://files.phpmyadmin.net/phpMyAdmin/' + $version + '/'
$tempRoot = Join-Path $env:TEMP ('manager-phpmyadmin-' + [guid]::NewGuid())
$archive = Join-Path $tempRoot $archiveName
$checksum = Join-Path $tempRoot ($archiveName + '.sha256')
$extract = Join-Path $tempRoot 'extract'

Write-Host ('Installing phpMyAdmin ' + $version)
New-Item -ItemType Directory -Force -Path $tempRoot,$extract,$toolsRoot | Out-Null
try {
    Invoke-WebRequest ($baseUrl + $archiveName) -OutFile $archive -UseBasicParsing
    Invoke-WebRequest ($baseUrl + $archiveName + '.sha256') -OutFile $checksum -UseBasicParsing
    $checksumLine = (Get-Content -LiteralPath $checksum -Raw).Trim()
    if ($checksumLine -notmatch '^([a-fA-F0-9]{64})\s+') { throw 'The phpMyAdmin checksum file is invalid' }
    $expected = $Matches[1].ToLowerInvariant()
    $actual = Get-Sha256 $archive
    if ($actual -ne $expected) { throw 'phpMyAdmin SHA256 verification failed' }
    Write-Host ('SHA256 verified: ' + $actual)

    Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force
    $source = Get-ChildItem -LiteralPath $extract -Directory | Select-Object -First 1
    if (-not $source -or -not (Test-Path -LiteralPath (Join-Path $source.FullName 'index.php'))) { throw 'The phpMyAdmin archive layout is invalid' }

    $previous = $installRoot + '.previous'
    if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Recurse -Force }
    if (Test-Path -LiteralPath $installRoot) { Move-Item -LiteralPath $installRoot -Destination $previous }
    Move-Item -LiteralPath $source.FullName -Destination $installRoot
    if (Test-Path -LiteralPath (Join-Path $installRoot 'setup')) { Remove-Item -LiteralPath (Join-Path $installRoot 'setup') -Recurse -Force }

    $config = @'
<?php
declare(strict_types=1);
$cfg['blowfish_secret'] = getenv('PHPMYADMIN_BLOWFISH_SECRET') ?: '';
$cfg['PmaAbsoluteUri'] = getenv('PHPMYADMIN_PUBLIC_URL') ?: '';
$cfg['TempDir'] = getenv('PHPMYADMIN_TEMP_DIR') ?: 'C:/web/temp/phpmyadmin';
$cfg['SessionSavePath'] = getenv('PHPMYADMIN_SESSION_DIR') ?: 'C:/web/temp/phpmyadmin-sessions';
$cfg['LoginCookieValidity'] = 1800;
$cfg['AllowArbitraryServer'] = false;
$i = 1;
$cfg['Servers'][$i]['auth_type'] = 'cookie';
$cfg['Servers'][$i]['host'] = getenv('PHPMYADMIN_DB_HOST') ?: '127.0.0.1';
$cfg['Servers'][$i]['port'] = getenv('PHPMYADMIN_DB_PORT') ?: '3306';
$cfg['Servers'][$i]['compress'] = false;
$cfg['Servers'][$i]['AllowNoPassword'] = false;
?>
'@
    Set-Content -LiteralPath (Join-Path $installRoot 'config.inc.php') -Value $config -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $installRoot 'VERSION') -Value $version -Encoding ASCII

    $backup = $iniPath + '.manager-phpmyadmin-backup'
    if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $iniPath -Destination $backup }
    foreach ($extension in @('mysqli','mbstring','openssl','curl','fileinfo','zip')) { Enable-PhpExtension $iniPath $extension }
    $required = @('mysqli','mbstring','openssl','curl','fileinfo','zip')
    $active = @(cmd.exe /d /c "php.exe -m 2>NUL" | ForEach-Object { ([string]$_).Trim().ToLowerInvariant() })
    $missing = @($required | Where-Object { $active -notcontains $_ })
    if ($missing.Count) { throw ('Required PHP extensions are missing: ' + ($missing -join ', ')) }
    Write-Host ('phpMyAdmin ' + $version + ' installed with required PHP extensions')
} catch {
    if (-not (Test-Path -LiteralPath $installRoot) -and (Test-Path -LiteralPath ($installRoot + '.previous'))) {
        Move-Item -LiteralPath ($installRoot + '.previous') -Destination $installRoot
    }
    throw
} finally {
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
