param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('mysql', 'mariadb')]
    [string]$Engine,
    [switch]$RepairMissingService,
    [string]$ServiceName,
    [string]$ServerExecutable,
    [string]$DefaultsFile
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + ';' + $env:PSModulePath
. (Join-Path $PSScriptRoot 'database-service.ps1')

$service = Get-DatabaseService $Engine $ServiceName
$repair = -not $service
if ($repair) {
    if ($Engine -ne 'mysql' -or -not $RepairMissingService) { throw "No installed $Engine Windows service was found. A client executable alone is not a database server." }
    if (-not $ServerExecutable) { $ServerExecutable = Find-MySqlServerExecutable }
    if (-not $ServerExecutable) { throw 'MySQL server binaries were not found. Install the MySQL server package; mysql.exe alone is only a client.' }
    if (-not $ServiceName) { $ServiceName = 'MySQL' }
    if ($ServiceName -notmatch '^[A-Za-z0-9_-]{1,80}$') { throw 'The repair service name contains unsupported characters.' }
    if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) { throw "Service $ServiceName already exists but is not the selected MySQL server. It has not been changed." }
    $executable = (Get-Item -LiteralPath $ServerExecutable -ErrorAction Stop).FullName
    $configPath = Get-DatabaseDefaultsFile $executable '' $DefaultsFile
} else {
    $ServiceName = $service.Name
    $executable = Get-DatabaseServiceExecutable $service.PathName
    if ($ServerExecutable -and (Get-Item -LiteralPath $ServerExecutable).FullName -ne (Get-Item -LiteralPath $executable).FullName) { throw 'The selected service uses a different server executable.' }
    $configPath = Get-DatabaseDefaultsFile $executable $service.PathName $DefaultsFile
}
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw "Database server executable was not found: $executable" }
$executable = (Get-Item -LiteralPath $executable).FullName
$options = Read-DatabaseOptions $executable $configPath $ServiceName
$port = if ($options.ContainsKey('port')) { [int]$options.port } else { 3306 }
if ($port -lt 1 -or $port -gt 65535) { throw 'The configured database port is invalid.' }

if ($repair) {
    $version = @(& $executable --no-defaults --version) -join ' '
    if ($LASTEXITCODE -ne 0 -or $version -notmatch 'MySQL' -or $version -match 'MariaDB') { throw 'The selected repair executable is not a MySQL server.' }
    $dataState = Get-MySqlDataState $options.datadir
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { throw "Port $port is already occupied. The installer will not replace or stop its owner." }
    $alreadyRunning = @(Get-CimInstance Win32_Process -Filter "Name='mysqld.exe'" | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $executable })
    if ($alreadyRunning.Count) { throw 'This MySQL executable is already running outside the selected service. Stop that instance before repairing its service.' }
    Write-Host "[repair] MySQL server files found; registering missing service $ServiceName using $configPath"
}

$lines = [System.Collections.Generic.List[string]]::new()
foreach ($line in [IO.File]::ReadAllLines($configPath)) { $lines.Add($line) }
$backup = "$configPath.manager-backup"
if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $configPath -Destination $backup }
$section = if ($Engine -eq 'mysql' -and $ServiceName -ne 'MySQL') { $ServiceName } else { 'mysqld' }
Set-DatabaseServerOption $lines $section 'bind-address' '127.0.0.1'
if ($Engine -eq 'mysql') { Set-DatabaseServerOption $lines $section 'mysqlx-bind-address' '127.0.0.1' }
[IO.File]::WriteAllLines($configPath, $lines, [Text.UTF8Encoding]::new($false))

if ($repair) {
    if ($dataState -eq 'empty') {
        Write-Host '[repair] Initializing the empty MySQL data directory; existing non-empty directories are never initialized'
        # Matches the fresh Chocolatey account setup; listeners are restricted to
        # loopback before startup. Manager's MySQL configuration secures root.
        Invoke-DatabaseNative $executable @(("--defaults-file=$configPath"),'--initialize-insecure',("--datadir=" + $options.datadir)) 'MySQL initialization'
    } else { Write-Host '[repair] Reusing the existing MySQL data directory without initialization' }
    # MySQL requires --install before --defaults-file. Invoke the binary directly;
    # cmd.exe single-quote handling can leave Chocolatey with files but no service.
    Invoke-DatabaseNative $executable @('--install',$ServiceName,("--defaults-file=$configPath")) 'MySQL service registration'
    $service = Get-DatabaseService 'mysql' $ServiceName
    if (-not $service) { throw 'MySQL did not register the requested Windows service.' }
    if ((Get-DatabaseServiceExecutable $service.PathName) -ne $executable) { throw 'The registered service executable does not match the selected MySQL server.' }
}

if ($service.State -eq 'Running') { Restart-Service -Name $ServiceName -ErrorAction Stop }
else { Start-Service -Name $ServiceName -ErrorAction Stop }
$running = Get-Service -Name $ServiceName
$running.WaitForStatus('Running', [TimeSpan]::FromSeconds(60))
$listeners = @()
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $refreshed = Get-CimInstance Win32_Service -Filter "Name='$($ServiceName.Replace("'", "''"))'"
    if ($refreshed.State -ne 'Running' -or -not $refreshed.ProcessId) { throw "Database service $ServiceName stopped during startup. Inspect the MySQL error log in its configured data directory." }
    $ownedProcessIds = @(Get-DatabaseListenerProcessIds $refreshed.ProcessId $executable @(Get-CimInstance Win32_Process -Filter "Name='mysqld.exe' OR Name='mariadbd.exe'"))
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $ownedProcessIds -contains [int]$_.OwningProcess })
    if (@($listeners | Where-Object { $_.LocalPort -eq $port }).Count) { break }
    Start-Sleep -Seconds 1
}
Assert-DatabaseListeners $listeners $port
Write-Output "[security] $Engine service $ServiceName is running with loopback-only listeners."
Write-Output "[security] Configuration: $configPath"
foreach ($listener in $listeners | Sort-Object LocalPort) { Write-Output "[verify] $($listener.LocalAddress):$($listener.LocalPort)" }
