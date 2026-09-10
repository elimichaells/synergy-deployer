$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + ';' + $env:PSModulePath
$repo = Split-Path $PSScriptRoot -Parent
. (Join-Path $repo 'scripts\database-service.ps1')
$sourceServer = Find-MySqlServerExecutable
if (-not $sourceServer) { throw 'Install MySQL server binaries before opting into this integration test.' }
$client = Join-Path (Split-Path $sourceServer -Parent) 'mysql.exe'
$testTemp = (Get-Item -LiteralPath $env:TEMP).FullName
$base = Join-Path $testTemp ('manager-mysql-integration-' + [guid]::NewGuid().ToString('N'))
$server = Join-Path $base 'server\bin\mysqld.exe'
$config = Join-Path $base 'config with spaces\my.ini'
$data = Join-Path $base 'data with spaces'
$name = 'ManagerMysqlFixture_' + [guid]::NewGuid().ToString('N').Substring(0,12)
$beforeServices = @(Get-CimInstance Win32_Service | Select-Object Name,PathName)
function Assert-TestService {
    if ($name -notmatch '^ManagerMysqlFixture_[a-f0-9]{12}$') { throw 'Unexpected test service name' }
    $instance = Get-CimInstance Win32_Service -Filter "Name='$name'"
    if ($instance -and ($instance.PathName -notlike ('*' + $config + '*'))) { throw 'Test service configuration does not match the fixture; refusing cleanup' }
    return $instance
}
function Remove-TestService {
    $instance = Assert-TestService
    if ($instance) {
        $controller = Get-Service -Name $name
        if ($controller.Status -ne 'Stopped') { Stop-Service -Name $name; $controller.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(60)) }
        $controller.Dispose()
        Invoke-DatabaseNative $server @('--remove',$name) 'Remove test service'
        for ($attempt=0; $attempt -lt 30; $attempt++) {
            if (-not (Get-CimInstance Win32_Service -Filter "Name='$name'")) { return }
            Start-Sleep -Milliseconds 200
        }
        throw 'The fixture service did not finish removal'
    }
}
function Invoke-FixtureSql([string]$Sql) {
    $result = @(& $client --no-defaults --protocol=TCP --host=127.0.0.1 ("--port=$port") --user=root --skip-password --batch --skip-column-names --execute=$Sql)
    if ($LASTEXITCODE -ne 0) { throw 'Fixture SQL failed' }
    return $result
}
try {
    New-Item -ItemType Directory -Path (Split-Path $config -Parent) -Force | Out-Null
    # Use a private executable too, so a host using the same MySQL distribution
    # can keep running while repair correctly refuses its active executable.
    $fixtureBin = Split-Path $server -Parent
    New-Item -ItemType Directory -Path $fixtureBin -Force | Out-Null
    $sourceBin = Split-Path $sourceServer -Parent
    foreach ($file in @(Get-ChildItem -LiteralPath $sourceBin -Filter '*.dll') + @((Get-Item -LiteralPath $sourceServer), (Get-Item -LiteralPath (Join-Path $sourceBin 'my_print_defaults.exe')))) {
        Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $fixtureBin $file.Name)
    }
    $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
    $probe.Start()
    $port = $probe.LocalEndpoint.Port
    $probe.Stop()
    $baseDir = (Split-Path (Split-Path $sourceServer -Parent) -Parent).Replace('\','/')
    @('[mysqld]',('basedir=' + $baseDir),('datadir=' + $data.Replace('\','/')),('port=' + $port),'mysqlx=0') | Set-Content -LiteralPath $config -Encoding ASCII
    $repairScript = Join-Path $repo 'scripts\configure-database-loopback.ps1'
    & $repairScript -Engine mysql -RepairMissingService -ServiceName $name -ServerExecutable $server -DefaultsFile $config
    $initialOptions = Read-DatabaseOptions $server $config $name
    if ($initialOptions.datadir.Replace('/','\') -ne $data) { throw 'Fixture configuration did not retain its data directory' }
    Invoke-FixtureSql 'CREATE DATABASE preserved_fixture; CREATE TABLE preserved_fixture.records (id INT PRIMARY KEY, value VARCHAR(50)); INSERT INTO preserved_fixture.records VALUES (1, ''keep-this-record'');' | Out-Null
    # Existing custom-named service must be reused with its registered configuration.
    & $repairScript -Engine mysql -RepairMissingService -ServiceName $name
    if ((Invoke-FixtureSql 'SELECT value FROM preserved_fixture.records WHERE id=1') -ne 'keep-this-record') { throw 'Restart lost the fixture record' }
    Remove-TestService
    & $repairScript -Engine mysql -RepairMissingService -ServiceName $name -ServerExecutable $server -DefaultsFile $config
    if ((Invoke-FixtureSql 'SELECT value FROM preserved_fixture.records WHERE id=1') -ne 'keep-this-record') { throw 'Service repair lost the existing database record' }
    Write-Output 'PASS: fresh initialization, existing service reuse, preserved SQL records after service repair'
} finally {
    Remove-TestService
    $allowed = $testTemp.TrimEnd('\') + '\manager-mysql-integration-'
    if (-not [IO.Path]::GetFullPath($base).StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected test directory cleanup path' }
    if (Test-Path -LiteralPath $base) { Remove-Item -LiteralPath $base -Recurse -Force }
    $afterServices = @{}
    foreach ($current in @(Get-CimInstance Win32_Service)) { $afterServices[$current.Name] = $current }
    foreach ($original in $beforeServices) {
        $current = $afterServices[$original.Name]
        if (-not $current -or $current.PathName -ne $original.PathName) { throw ('An existing service changed: ' + $original.Name) }
    }
}
