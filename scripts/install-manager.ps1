[CmdletBinding()]
param([string]$ConfigPath, [switch]$Unattended, [switch]$Plan)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$packageRoot = Split-Path -Parent $PSScriptRoot
$results = [System.Collections.Generic.List[object]]::new()

function Write-Step([string]$Message) {
    Write-Host ''
    Write-Host ('==> ' + $Message) -ForegroundColor Cyan
}

function Add-Result([string]$Check, [string]$Status, [string]$Detail) {
    $results.Add([pscustomobject]@{ check=$Check; status=$Status; detail=$Detail })
    $color = if ($Status -eq 'pass') { 'Green' } elseif ($Status -eq 'warn') { 'Yellow' } else { 'Red' }
    Write-Host ('[{0}] {1}: {2}' -f $Status.ToUpperInvariant(),$Check,$Detail) -ForegroundColor $color
}

function Test-Command([string]$Name) {
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function New-Secret([int]$Bytes = 48) {
    $buffer = New-Object byte[] $Bytes
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($buffer) } finally { $generator.Dispose() }
    return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+','-').Replace('/','_')
}

function Get-Setting([string]$Name, $Default, [switch]$Secret, [switch]$Required) {
    $value = $null
    if ($script:Config.PSObject.Properties.Name -contains $Name) { $value = $script:Config.$Name }
    if ($null -eq $value -or ($value -is [string] -and [string]::IsNullOrWhiteSpace($value))) {
        $environmentValue = [Environment]::GetEnvironmentVariable(('MANAGER_INSTALL_' + $Name.ToUpperInvariant()))
        if ($environmentValue) { $value = $environmentValue }
    }
    if (($null -eq $value -or $value -eq '') -and -not $Unattended) {
        $label = if ($null -ne $Default -and $Default -ne '') { $Name + ' [' + $Default + ']' } else { $Name }
        if ($Secret) {
            $secure = Read-Host $label -AsSecureString
            $value = [Net.NetworkCredential]::new('',$secure).Password
        } else {
            $entered = Read-Host $label
            $value = if ($entered) { $entered } else { $Default }
        }
    }
    if (($null -eq $value -or $value -eq '') -and $null -ne $Default) { $value = $Default }
    if ($Required -and ($null -eq $value -or $value -eq '')) { throw ($Name + ' is required') }
    return $value
}

function Get-ListSetting([string]$Name, [string[]]$Default = @()) {
    $value = Get-Setting $Name ($Default -join ',')
    if ($null -eq $value) { return @() }
    $items = if ($value -is [string]) { $value -split '[,;]' } else { @($value) }
    return @($items | ForEach-Object { ([string]$_).Trim().ToLowerInvariant() } | Where-Object { $_ })
}

function Get-BoolSetting([string]$Name, [bool]$Default) {
    $value = Get-Setting $Name $Default
    if ($value -is [bool]) { return $value }
    switch (([string]$value).Trim().ToLowerInvariant()) {
        { $_ -in @('true','1','yes','y','on') } { return $true }
        { $_ -in @('false','0','no','n','off') } { return $false }
        default { throw ($Name + ' must be true or false') }
    }
}

function Invoke-Native([string]$File, [string[]]$Arguments, [string]$Label) {
    if ($Plan) { Add-Result $Label 'warn' ('Plan: ' + $File + ' ' + ($Arguments -join ' ')); return }
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw ($Label + ' failed with exit code ' + $LASTEXITCODE) }
}

function Ensure-Chocolatey {
    if (Test-Command 'choco.exe') { Add-Result 'Chocolatey' 'pass' 'Installed'; return }
    if ($Plan) { Add-Result 'Chocolatey' 'warn' 'Would install Chocolatey'; return }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $install = (New-Object Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1')
    Invoke-Expression $install
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
    if (-not (Test-Command 'choco.exe')) { throw 'Chocolatey installation failed' }
}

function Ensure-Package([string]$Command, [string]$Package, [string[]]$Parameters = @()) {
    if (Test-Command $Command) { Add-Result $Package 'pass' 'Already installed'; return }
    Invoke-Native 'choco.exe' (@('install',$Package,'-y','--no-progress') + $Parameters) ('Install ' + $Package)
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
    Add-Result $Package 'pass' 'Installation requested'
}

function Ensure-NodeLts {
    Invoke-Native 'choco.exe' @('upgrade','nodejs-lts','-y','--no-progress') 'Install or update Node.js LTS'
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
    if (-not (Test-Command 'node.exe') -or -not (Test-Command 'npm.cmd')) { throw 'Node.js LTS installation did not provide node.exe and npm.cmd' }
}

function Get-NativeVersion([string]$File, [string[]]$Arguments) {
    try {
        $output = @(& $File @Arguments 2>$null)
        if ($LASTEXITCODE -ne 0 -or $output.Count -eq 0) { return 'unknown' }
        return ([string]$output[0]).Trim()
    } catch { return 'unknown' }
}

function Ensure-LatestNpm {
    $nodeVersion = Get-NativeVersion 'node.exe' @('--version')
    $installedVersion = Get-NativeVersion 'npm.cmd' @('--version')
    $latestVersion = Get-NativeVersion 'npm.cmd' @('view','npm@latest','version','--silent')
    if ($latestVersion -eq 'unknown') { throw 'Could not resolve the latest npm release from the npm registry' }
    if ($installedVersion -ne $latestVersion) {
        Invoke-Native 'npm.cmd' @('install','--global',('npm@' + $latestVersion),'--no-audit','--no-fund') ('Install npm ' + $latestVersion)
    }
    $activeVersion = Get-NativeVersion 'npm.cmd' @('--version')
    if ($activeVersion -ne $latestVersion) { throw ('npm upgrade did not activate the requested version ' + $latestVersion) }
    Add-Result 'Node.js' 'pass' $nodeVersion
    Add-Result 'npm' 'pass' $activeVersion
}

function Find-PostgresTool([string]$Tool) {
    $command = Get-Command ($Tool + '.exe') -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidate = Get-ChildItem 'C:\Program Files\PostgreSQL' -Filter ($Tool + '.exe') -Recurse -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
    if ($candidate) { return $candidate.FullName }
    return $null
}

function Escape-Sql([string]$Value) { return $Value.Replace("'","''") }

function Initialize-ApplicationPostgres {
    $initdb = Find-PostgresTool 'initdb'
    $pgCtl = Find-PostgresTool 'pg_ctl'
    $pgIsReady = Find-PostgresTool 'pg_isready'
    if (-not $initdb -or -not $pgCtl -or -not $pgIsReady) { throw 'PostgreSQL server tools were not found' }

    $clusterMarker = Join-Path $appDbDataDirectory 'PG_VERSION'
    $clusterExists = Test-Path -LiteralPath $clusterMarker -PathType Leaf
    $service = Get-Service -Name $appDbServiceName -ErrorAction SilentlyContinue
    if (-not $clusterExists) {
        if (-not $appDbAdminPassword) { throw 'AppDbAdminPassword is required to initialize application PostgreSQL' }
        New-Item -ItemType Directory -Force -Path $appDbDataDirectory | Out-Null
        $passwordFile = Join-Path $env:TEMP ('manager-app-postgres-' + [guid]::NewGuid() + '.pw')
        Set-Content -LiteralPath $passwordFile -Value $appDbAdminPassword -Encoding ASCII -NoNewline
        try {
            Invoke-Native $initdb @('-D',$appDbDataDirectory,'-U',$appDbAdminUser,'--encoding=UTF8','--auth-host=scram-sha-256','--auth-local=scram-sha-256','--pwfile',$passwordFile) 'Initialize application PostgreSQL cluster'
        } finally { Remove-Item -LiteralPath $passwordFile -Force -ErrorAction SilentlyContinue }
        Add-Content -LiteralPath (Join-Path $appDbDataDirectory 'postgresql.conf') -Value @"

# Managed application database isolation
listen_addresses = '127.0.0.1'
port = $appDbPort
password_encryption = 'scram-sha-256'
"@
        & icacls.exe $appDbDataDirectory /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-20:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Failed to secure the application PostgreSQL data directory' }
        $script:ApplicationPostgresCreated = $true
    }

    if (-not $service) {
        Invoke-Native $pgCtl @('register','-N',$appDbServiceName,'-D',$appDbDataDirectory,'-U','NT AUTHORITY\NetworkService','-S','auto','-o',('-p ' + $appDbPort)) 'Register application PostgreSQL service'
        $service = Get-Service -Name $appDbServiceName -ErrorAction Stop
    }
    if ($service.Status -ne 'Running') { Start-Service -Name $appDbServiceName }
    for ($attempt=0; $attempt -lt 30; $attempt++) {
        & $pgIsReady -h 127.0.0.1 -p $appDbPort -d postgres 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Seconds 1
    }
    & $pgIsReady -h 127.0.0.1 -p $appDbPort -d postgres 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Application PostgreSQL did not become ready' }

    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $appDbPort -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) { throw 'Application PostgreSQL is ready but no listener was found' }
    $publicListener = $listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1','::1') }
    if ($publicListener) { throw 'Application PostgreSQL must listen only on loopback addresses' }
    Add-Result 'Application PostgreSQL' 'pass' ('Healthy on 127.0.0.1:' + $appDbPort + ' as service ' + $appDbServiceName)
}

function Wait-Http([string]$Url) {
    for ($attempt=0; $attempt -lt 30; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return $response.StatusCode }
        } catch {}
        Start-Sleep -Seconds 2
    }
    throw ('Health check did not respond: ' + $Url)
}

$script:Config = if ($ConfigPath) {
    if (-not (Test-Path -LiteralPath $ConfigPath)) { throw ('Config file not found: ' + $ConfigPath) }
    Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
} else { [pscustomobject]@{} }

Write-Host 'Manager for Windows Server' -ForegroundColor White
Write-Host 'Preflight, installation, configuration, and verification wizard' -ForegroundColor DarkGray

$managerDomain = [string](Get-Setting 'ManagerDomain' $null -Required)
$managerPort = [int](Get-Setting 'ManagerPort' 4000)
$managerRoot = [string](Get-Setting 'ManagerRoot' 'C:\web\manager')
$webRoot = [string](Get-Setting 'WebRoot' 'C:\web')
$adminName = [string](Get-Setting 'AdminName' 'Administrator')
$adminEmail = [string](Get-Setting 'AdminEmail' $null -Required)
$adminPassword = [string](Get-Setting 'AdminPassword' $null -Secret -Required:(-not $Plan))
$dbHost = [string](Get-Setting 'DbHost' '127.0.0.1')
$dbPort = [int](Get-Setting 'DbPort' 5432)
$dbName = [string](Get-Setting 'DbName' 'server_manager')
$dbAdminUser = [string](Get-Setting 'DbAdminUser' 'postgres')
$dbAdminPassword = [string](Get-Setting 'DbAdminPassword' $null -Secret -Required:(-not $Plan))
$dbAppUser = [string](Get-Setting 'DbAppUser' 'manager_app')
$dbAppPassword = [string](Get-Setting 'DbAppPassword' (New-Secret 32))
$installPostgres = Get-BoolSetting 'InstallPostgreSQL' $true
$installApplicationPostgres = Get-BoolSetting 'InstallApplicationPostgreSQL' $true
$appDbPort = [int](Get-Setting 'AppDbPort' 5433)
$appDbAdminUser = [string](Get-Setting 'AppDbAdminUser' 'manager_project_admin')
$appDbDataDirectory = [string](Get-Setting 'AppDbDataDirectory' (Join-Path $env:ProgramData 'Manager\postgres-app'))
$appDbServiceName = [string](Get-Setting 'AppDbServiceName' 'ManagerPostgreSQLApplications')
$appDbConnectionName = [string](Get-Setting 'AppDbConnectionName' 'Managed application PostgreSQL')
$appDbAdminPassword = if ($installApplicationPostgres) { [string](Get-Setting 'AppDbAdminPassword' $null -Secret) } else { '' }
$appDbClusterExists = Test-Path -LiteralPath (Join-Path $appDbDataDirectory 'PG_VERSION') -PathType Leaf
if ($installApplicationPostgres -and -not $appDbClusterExists -and -not $appDbAdminPassword -and -not $Plan) { $appDbAdminPassword = New-Secret 32 }
$installPgweb = Get-BoolSetting 'InstallPgweb' $true
$installLatestNpm = Get-BoolSetting 'InstallLatestNpm' $true
$optionalRuntimes = @(Get-ListSetting 'OptionalRuntimes' @('go','php','composer'))
$optionalEngines = @(Get-ListSetting 'OptionalDatabaseEngines' @())
$postgresPackage = [string](Get-Setting 'PostgreSqlPackage' 'postgresql18')
$caddyExe = Join-Path $webRoot 'caddy.exe'
$caddyfile = Join-Path $webRoot 'Caddyfile'
$pm2Home = Join-Path $env:ProgramData 'Manager\pm2'
$reportPath = Join-Path $env:ProgramData 'Manager\install-report.json'
if ($Plan -and -not $adminPassword) { $adminPassword = 'PLAN_ONLY' }
if ($Plan -and -not $dbAdminPassword) { $dbAdminPassword = 'PLAN_ONLY' }
if ($Plan -and -not $appDbAdminPassword) { $appDbAdminPassword = 'PLAN_ONLY' }

Write-Step 'Running preflight checks'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run from an elevated PowerShell session' }
Add-Result 'Administrator' 'pass' $identity.Name
if (-not [Environment]::Is64BitOperatingSystem) { throw 'A 64-bit Windows installation is required' }
Add-Result 'Operating system' 'pass' ([Environment]::OSVersion.VersionString)
$driveName = [IO.Path]::GetPathRoot($webRoot).TrimEnd('\').TrimEnd(':')
$drive = Get-PSDrive -Name $driveName
if ($drive.Free -lt 5GB) { throw 'At least 5 GB of free disk space is required' }
Add-Result 'Disk space' 'pass' ('{0:N1} GB free' -f ($drive.Free/1GB))
if (Get-NetTCPConnection -State Listen -LocalPort $managerPort -ErrorAction SilentlyContinue) { Add-Result 'Manager port' 'warn' ($managerPort.ToString() + ' is already in use') }
else { Add-Result 'Manager port' 'pass' ($managerPort.ToString() + ' is available') }
if ($installApplicationPostgres) {
    if ($appDbPort -eq $dbPort) { throw 'AppDbPort must differ from the Manager control database port' }
    $appService = Get-Service -Name $appDbServiceName -ErrorAction SilentlyContinue
    $appListener = Get-NetTCPConnection -State Listen -LocalPort $appDbPort -ErrorAction SilentlyContinue
    if ($appListener -and -not $appService) { throw ('AppDbPort ' + $appDbPort + ' is already used by another service') }
    $appPlan = if ($appDbClusterExists) { 'Existing isolated cluster will be verified' } else { 'Isolated cluster will be created' }
    Add-Result 'Application PostgreSQL plan' 'pass' ($appPlan + ' at 127.0.0.1:' + $appDbPort)
}
try {
    $addresses = [Net.Dns]::GetHostAddresses($managerDomain)
    Add-Result 'Manager DNS' 'pass' (($addresses | ForEach-Object IPAddressToString) -join ', ')
} catch { Add-Result 'Manager DNS' 'warn' 'DNS does not resolve yet. Public TLS will wait for DNS.' }

if ($Plan) {
    Write-Host ''
    Write-Host 'Plan completed. No changes were made.' -ForegroundColor Yellow
    $results | Format-Table -AutoSize
    exit 0
}

Ensure-Chocolatey
Write-Step 'Installing host dependencies'
Ensure-Package 'git.exe' 'git'
Ensure-NodeLts
if ($installLatestNpm) { Ensure-LatestNpm }
else {
    Add-Result 'Node.js' 'pass' (Get-NativeVersion 'node.exe' @('--version'))
    Add-Result 'npm' 'pass' ((Get-NativeVersion 'npm.cmd' @('--version')) + ' (bundled with Node.js)')
}
Ensure-Package 'caddy.exe' 'caddy'
Invoke-Native 'powershell.exe' @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $packageRoot 'scripts\install-sling.ps1')) 'Install database migration engine'
if (($installPostgres -or $installApplicationPostgres) -and -not (Find-PostgresTool 'psql')) {
    Ensure-Package 'psql.exe' $postgresPackage @('--params',('/Password:' + $dbAdminPassword + ' /Port:' + $dbPort))
}
if ($installApplicationPostgres) { Initialize-ApplicationPostgres }
if ($optionalRuntimes -contains 'go') { Ensure-Package 'go.exe' 'golang' }
if ($optionalRuntimes -contains 'php') { Ensure-Package 'php.exe' 'php' }
if ($optionalRuntimes -contains 'composer') { Ensure-Package 'composer.exe' 'composer' }
if ($optionalEngines -contains 'mysql') { Ensure-Package 'mysql.exe' 'mysql' }
if ($optionalEngines -contains 'mariadb') { Ensure-Package 'mariadb.exe' 'mariadb' }
if ($optionalEngines -contains 'mongodb') { Ensure-Package 'mongod.exe' 'mongodb' }
if ($optionalEngines -contains 'sqlserver') { Ensure-Package 'sqlcmd.exe' 'sql-server-express' }
if ($optionalEngines -contains 'redis') { Add-Result 'Redis' 'warn' 'Register a remote Redis or a supported Windows-compatible distribution after installation' }
if (-not (Test-Command 'pm2.cmd')) { Invoke-Native 'npm.cmd' @('install','--global','pm2') 'Install PM2' }

Write-Step 'Preparing directories and application files'
@($webRoot,$managerRoot,(Join-Path $webRoot 'production'),(Join-Path $webRoot 'staging'),(Join-Path $webRoot 'logs'),(Join-Path $webRoot 'tools'),(Join-Path $env:ProgramData 'Manager'),$pm2Home,'C:\Caddy\logs') |
    ForEach-Object { New-Item -ItemType Directory -Force -Path $_ | Out-Null }
if ([IO.Path]::GetFullPath($packageRoot).TrimEnd('\') -ne [IO.Path]::GetFullPath($managerRoot).TrimEnd('\')) {
    & robocopy.exe $packageRoot $managerRoot /MIR /XD .git node_modules .next packages /XF .env.local *.log /NFL /NDL /NJH /NJS
    if ($LASTEXITCODE -ge 8) { throw ('Application copy failed: ' + $LASTEXITCODE) }
}
$installedCaddy = (Get-Command caddy.exe).Source
if ([IO.Path]::GetFullPath($installedCaddy) -ne [IO.Path]::GetFullPath($caddyExe)) { Copy-Item $installedCaddy $caddyExe -Force }

Write-Step 'Creating the Manager control database'
$psql = Find-PostgresTool 'psql'
if (-not $psql) { throw 'psql.exe was not found' }
$env:PGPASSWORD = $dbAdminPassword
$sqlPath = Join-Path $env:TEMP ('manager-init-' + [guid]::NewGuid() + '.sql')
$sqlTemplate = @'
DO $manager$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{0}') THEN
    CREATE ROLE "{1}" LOGIN PASSWORD '{2}';
  ELSE
    ALTER ROLE "{1}" WITH LOGIN PASSWORD '{2}';
  END IF;
END
$manager$;
SELECT 'CREATE DATABASE "{3}" OWNER "{1}"'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '{4}')\gexec
'@
$sql = $sqlTemplate -f (Escape-Sql $dbAppUser),$dbAppUser.Replace('"','""'),(Escape-Sql $dbAppPassword),$dbName.Replace('"','""'),(Escape-Sql $dbName)
$sql | Set-Content -LiteralPath $sqlPath -Encoding UTF8
try { Invoke-Native $psql @('-h',$dbHost,'-p',$dbPort,'-U',$dbAdminUser,'-d','postgres','-v','ON_ERROR_STOP=1','-f',$sqlPath) 'Initialize control database' }
finally { Remove-Item $sqlPath -Force -ErrorAction SilentlyContinue; Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }

Write-Step 'Installing and building Manager'
Push-Location $managerRoot
try {
    Invoke-Native 'npm.cmd' @('ci') 'Install application dependencies'
    $envPath = Join-Path $managerRoot '.env.local'
    $jwtSecret = New-Secret
    $managerEncryptionKey = New-Secret
    $environmentText = @(
        'MANAGER_DOMAIN=' + $managerDomain
        'MANAGER_PORT=' + $managerPort
        'DATABASE_HOST=' + $dbHost
        'DATABASE_PORT=' + $dbPort
        'DATABASE_NAME=' + $dbName
        'DATABASE_USER=' + $dbAppUser
        'DATABASE_PASSWORD=' + $dbAppPassword
        'JWT_SECRET=' + $jwtSecret
        'MANAGER_ENCRYPTION_KEY=' + $managerEncryptionKey
        'PRODUCTION_PATH=' + (Join-Path $webRoot 'production').Replace('\','\\')
        'STAGING_PATH=' + (Join-Path $webRoot 'staging').Replace('\','\\')
        'LOGS_PATH=' + (Join-Path $webRoot 'logs').Replace('\','\\')
        'CADDY_PATH=' + $webRoot.Replace('\','\\')
        'CADDYFILE_PATH=' + $caddyfile.Replace('\','\\')
        'CADDY_EXE=' + $caddyExe.Replace('\','\\')
        'PGWEB_EXE=' + (Join-Path $webRoot 'tools\pgweb\pgweb.exe').Replace('\','\\')
        'PGWEB_PORT=8432'
    ) -join [Environment]::NewLine
    Set-Content -LiteralPath $envPath -Value $environmentText -Encoding UTF8
    & icacls.exe $envPath /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
    $env:DATABASE_HOST=$dbHost; $env:DATABASE_PORT=$dbPort; $env:DATABASE_NAME=$dbName
    $env:DATABASE_USER=$dbAppUser; $env:DATABASE_PASSWORD=$dbAppPassword
    $env:ADMIN_EMAIL=$adminEmail; $env:ADMIN_NAME=$adminName; $env:ADMIN_PASSWORD=$adminPassword
    $env:MANAGER_ENCRYPTION_KEY=$managerEncryptionKey
    if ($installApplicationPostgres -and $appDbAdminPassword) {
        $env:APP_POSTGRES_HOST='127.0.0.1'; $env:APP_POSTGRES_PORT=$appDbPort
        $env:APP_POSTGRES_ADMIN_USER=$appDbAdminUser; $env:APP_POSTGRES_ADMIN_PASSWORD=$appDbAdminPassword
        $env:APP_POSTGRES_CONNECTION_NAME=$appDbConnectionName; $env:APP_POSTGRES_SERVICE_NAME=$appDbServiceName
    }
    Invoke-Native 'node.exe' @('scripts\initialize-manager.js') 'Apply schema and create administrator'
    Invoke-Native 'npm.cmd' @('run','build') 'Build Manager'
} finally { Pop-Location }

Write-Step 'Configuring and validating Caddy'
$managerBlock = @"
# $managerDomain
$managerDomain {
    reverse_proxy 127.0.0.1:$managerPort {
        header_up Host {host}
        header_up X-Real-IP {remote}
        header_up X-Forwarded-Proto {scheme}
    }
    log {
        output file C:\Caddy\logs\$($managerDomain.Replace('.','-'))-error.log {
            roll_size 10MB
            roll_keep 5
        }
        format console
        level ERROR
    }
}
"@
if (-not (Test-Path $caddyfile)) { Set-Content $caddyfile $managerBlock -Encoding UTF8 }
elseif ((Get-Content $caddyfile -Raw) -notmatch [regex]::Escape($managerDomain + ' {')) { Add-Content $caddyfile ([Environment]::NewLine + $managerBlock) }
Invoke-Native $caddyExe @('validate','--config',$caddyfile,'--adapter','caddyfile') 'Validate Caddy configuration'

if ($installPgweb) {
    Write-Step 'Installing Pgweb'
    $pgwebDirectory = Join-Path $webRoot 'tools\pgweb'
    $pgwebExe = Join-Path $pgwebDirectory 'pgweb.exe'
    New-Item -ItemType Directory -Force -Path $pgwebDirectory | Out-Null
    if (-not (Test-Path $pgwebExe)) {
        $zipPath = Join-Path $env:TEMP 'pgweb_windows_amd64.zip'
        Invoke-WebRequest 'https://github.com/sosedoff/pgweb/releases/download/v0.17.0/pgweb_windows_amd64.zip' -OutFile $zipPath -UseBasicParsing
        Expand-Archive $zipPath $pgwebDirectory -Force
        Remove-Item $zipPath -Force
        $downloaded = Get-ChildItem $pgwebDirectory -Filter 'pgweb*.exe' | Select-Object -First 1
        if ($downloaded.FullName -ne $pgwebExe) { Move-Item $downloaded.FullName $pgwebExe -Force }
    }
}

Write-Step 'Starting services and configuring boot recovery'
$env:PM2_HOME = $pm2Home
foreach ($processName in @('manager','manager-caddy','manager-pgweb')) { & pm2.cmd delete $processName 2>$null | Out-Null }
$nextBin = Join-Path $managerRoot 'node_modules\next\dist\bin\next'
Invoke-Native 'pm2.cmd' @('start',$nextBin,'--interpreter','node','--name','manager','--','start','-p',$managerPort) 'Start Manager'
Invoke-Native 'pm2.cmd' @('start',$caddyExe,'--name','manager-caddy','--interpreter','none','--','run','--config',$caddyfile,'--adapter','caddyfile') 'Start Caddy'
if ($installPgweb) { Invoke-Native 'pm2.cmd' @('start',(Join-Path $managerRoot 'scripts\pm2-pgweb-runner.js'),'--name','manager-pgweb') 'Start Pgweb' }
Invoke-Native 'pm2.cmd' @('save') 'Save PM2 process list'
$startupScript = Join-Path $managerRoot 'scripts\pm2-resurrect.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $startupScript + '"')
$trigger = New-ScheduledTaskTrigger -AtStartup
$taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'Manager PM2 Startup' -Action $action -Trigger $trigger -Principal $taskPrincipal -Description 'Restores Manager and deployed applications after boot.' -Force | Out-Null

Write-Step 'Applying firewall policy'
foreach ($port in @(80,443)) {
    $displayName = 'Manager HTTP ' + $port
    if (-not (Get-NetFirewallRule -DisplayName $displayName -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName $displayName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port | Out-Null
    }
}
Add-Result 'Database firewall' 'pass' 'No database engine ports were opened'

Write-Step 'Verifying installation'
$status = Wait-Http ('http://127.0.0.1:' + $managerPort + '/login')
Add-Result 'Manager health' 'pass' ('Local login returned HTTP ' + $status)
Invoke-Native $caddyExe @('validate','--config',$caddyfile,'--adapter','caddyfile') 'Final Caddy validation'

$report = [ordered]@{
    installedAt=(Get-Date).ToUniversalTime().ToString('o')
    managerDomain=$managerDomain
    managerPort=$managerPort
    managerRoot=$managerRoot
    webRoot=$webRoot
    controlDatabase=@{host=$dbHost;port=$dbPort;name=$dbName;user=$dbAppUser}
    applicationDatabase=if ($installApplicationPostgres) { @{host='127.0.0.1';port=$appDbPort;service=$appDbServiceName;dataDirectory=$appDbDataDirectory;connectionName=$appDbConnectionName} } else { $null }
    optionalRuntimes=$optionalRuntimes
    optionalDatabaseEngines=$optionalEngines
    pgweb=$installPgweb
    components=[ordered]@{
        node=Get-NativeVersion 'node.exe' @('--version')
        npm=Get-NativeVersion 'npm.cmd' @('--version')
        git=Get-NativeVersion 'git.exe' @('--version')
        pm2=Get-NativeVersion 'pm2.cmd' @('--version')
        caddy=Get-NativeVersion $caddyExe @('version')
        postgresql=Get-NativeVersion $psql @('--version')
    }
    checks=$results
}
$report | ConvertTo-Json -Depth 6 | Set-Content $reportPath -Encoding UTF8
Write-Host ''
Write-Host 'Manager installation completed.' -ForegroundColor Green
Write-Host ('URL: https://' + $managerDomain) -ForegroundColor Green
Write-Host ('Report: ' + $reportPath) -ForegroundColor DarkGray
Write-Host 'Manager control and application databases are isolated. Database ports remain private.' -ForegroundColor DarkGray
