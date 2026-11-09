$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:MANAGER_DATABASE_LAB -ne '1' -or $env:RUNNER_OS -ne 'Windows'){throw 'Database lab requires a disposable GitHub-hosted Windows VM; production use is prohibited.'}
$root='C:\ManagerDatabaseLab'
if((Test-Path -LiteralPath $root) -or (Test-Path -LiteralPath 'C:\ProgramData\Manager')){throw 'Disposable database lab must start without Manager or previous lab state'}
New-Item -ItemType Directory -Path $root,(Join-Path $root 'private'),(Join-Path $root 'results') | Out-Null
& icacls.exe (Join-Path $root 'private') /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if($LASTEXITCODE){throw 'Could not protect disposable database credentials'}
$lock=Get-Content (Join-Path $PSScriptRoot '..\..\installer\offline\dependencies.lock.json') -Raw | ConvertFrom-Json
$binaries=@{}
foreach($engine in @('mysql','mariadb')){
  $item=@($lock.artifacts | Where-Object id -eq $engine)[0]
  $archive=Join-Path $root $item.file
  Invoke-WebRequest -Uri $item.url -OutFile $archive
  if((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $item.sha256){throw "$engine archive checksum mismatch"}
  $extract=Join-Path $root ($engine+' binaries')
  Expand-Archive -LiteralPath $archive -DestinationPath $extract
  $binaries[$engine]=Join-Path $extract $item.root
}
$instances=@()
foreach($item in @(@{engine='mysql';name='ManagerLabMySQLTarget';port=33161},@{engine='mysql';name='ManagerLabMySQLPeer';port=33162},@{engine='mariadb';name='ManagerLabMariaDBTarget';port=33163})){
  $instanceRoot=Join-Path $root ($item.name+' custom path')
  New-Item -ItemType Directory -Path $instanceRoot | Out-Null
  $data=Join-Path $instanceRoot 'existing data'
  $config=Join-Path $instanceRoot 'custom database.ini'
  $bin=Join-Path $binaries[$item.engine] 'bin'
  $exe=Join-Path $bin $(if($item.engine -eq 'mysql'){'mysqld.exe'}else{'mariadbd.exe'})
  if($item.engine -eq 'mariadb'){
    $initialize=Join-Path $bin 'mariadb-install-db.exe'
    if(!(Test-Path -LiteralPath $initialize)){$initialize=Join-Path $bin 'mysql_install_db.exe'}
    & $initialize "--datadir=$data"
    if($LASTEXITCODE){throw 'MariaDB initialization failed'}
  }
  $lines=@('[mysqld]',('basedir='+$binaries[$item.engine].Replace('\','/')),('datadir='+$data.Replace('\','/')),('port='+$item.port),'bind-address=127.0.0.1','performance_schema=ON','innodb_log_buffer_size=64M','innodb_buffer_pool_size=128M')
  if($item.engine -eq 'mysql'){$lines+=@('mysqlx=OFF')}
  [IO.File]::WriteAllLines($config,$lines,[Text.UTF8Encoding]::new($false))
  if($item.engine -eq 'mysql'){
    & $exe "--defaults-file=$config" --initialize-insecure
    if($LASTEXITCODE){throw 'MySQL initialization failed'}
  }
  & $exe --install $item.name "--defaults-file=$config"
  if($LASTEXITCODE){throw 'Disposable database service registration failed'}
  Start-Service -Name $item.name
  (Get-Service -Name $item.name).WaitForStatus('Running',[TimeSpan]::FromSeconds(60))
  $instances+=@{provider=$item.engine;name=$item.name;port=$item.port;config=$config;data=$data;executable=$exe;client=(Join-Path $bin $(if($item.engine -eq 'mysql'){'mysql.exe'}else{'mariadb.exe'}))}
}
$inventory=@{computer=$env:COMPUTERNAME;runId=$env:GITHUB_RUN_ID;sourceCommit=$env:GITHUB_SHA;instances=$instances}
[IO.File]::WriteAllText((Join-Path $root 'private\instances.json'),($inventory|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
Write-Host '[pass] Three isolated services initialized using custom paths and loopback-only ports.'
