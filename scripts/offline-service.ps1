[CmdletBinding()]
param(
    [ValidateSet('mysql','mariadb','mongodb','sqlserver','phpmyadmin')][string]$Engine,
    [ValidateSet('Install','Verify','Credential')][string]$Action = 'Verify',
    [string]$ManagerRoot,
    [string]$DataRoot = (Join-Path $env:ProgramData 'Manager')
)

. (Join-Path $PSScriptRoot 'installer-offline.ps1')
. (Join-Path $PSScriptRoot 'database-service.ps1')

function Write-ServiceJson($Path, $Value) {
    $temporary = $Path + '.new'
    [IO.File]::WriteAllText($temporary,($Value | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Protect-ServiceDirectory([string]$Path) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    & icacls.exe $Path /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not protect service files' }
}

function Get-OfflineServiceSpec([string]$Id) {
    switch ($Id) {
        'mysql' { return @{Service='ManagerMySQL';Port=3306;Binary='bin\mysqld.exe';User='manager_project_admin'} }
        'mariadb' { return @{Service='ManagerMariaDB';Port=3307;Binary='bin\mariadbd.exe';User='manager_project_admin'} }
        'mongodb' { return @{Service='ManagerMongoDB';Port=27017;Binary='bin\mongod.exe';User='manager_project_admin'} }
        'sqlserver' { return @{Service='MSSQL$MANAGER';Port=1433;Binary='MSSQL16.MANAGER\MSSQL\Binn\sqlservr.exe';User='sa'} }
        'phpmyadmin' { return @{Service='';Port=8433;Binary='index.php';User=''} }
        default { throw 'Unsupported offline service' }
    }
}

function Read-ServicePackage([string]$BundleRoot,[string]$Id) {
    $manifest = Get-Content -LiteralPath (Join-Path $BundleRoot 'services.json') -Raw | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.architecture -ne 'win-x64' -or [Environment]::OSVersion.Version.Build -lt $manifest.minimumWindowsBuild) { throw 'Unsupported offline service bundle or Windows version' }
    $matches = @($manifest.artifacts | Where-Object { $_.id -eq $Id })
    if ($matches.Count -ne 1) { throw ('Offline package is missing or duplicated: ' + $Id) }
    $item = $matches[0]
    $file = Get-ManagerOfflinePath $BundleRoot $item.file
    if ($item.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or -not (Test-Path -LiteralPath $file -PathType Leaf) -or
        (Get-Item -LiteralPath $file).Length -ne [long]$item.bytes -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $item.sha256) {
        throw ('Offline package failed SHA-256 verification: ' + $Id + '. No download will be attempted.')
    }
    return @{Item=$item;File=$file}
}

function Read-ServiceCredential([string]$StateRoot) {
    Add-Type -AssemblyName System.Security
    $encoded = [IO.File]::ReadAllBytes((Join-Path $StateRoot 'credential.dpapi'))
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($encoded,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)
    try { return [Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json }
    finally { [Array]::Clear($plain,0,$plain.Length) }
}

function New-ServiceCredential([string]$StateRoot,[string]$User) {
    Add-Type -AssemblyName System.Security
    $random = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($random) } finally { $generator.Dispose() }
    $credential = @{username=$User;password=('Mg!A1' + [BitConverter]::ToString($random).Replace('-',''))}
    $plain = [Text.Encoding]::UTF8.GetBytes(($credential | ConvertTo-Json -Compress))
    try {
        $protected = [Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)
        [IO.File]::WriteAllBytes((Join-Path $StateRoot 'credential.dpapi'),$protected)
    } finally { [Array]::Clear($plain,0,$plain.Length) }
    return $credential
}

function Assert-ServiceOwnership($Receipt) {
    $service = Get-CimInstance Win32_Service -Filter ("Name='" + $Receipt.service + "'")
    if (-not $service -or (Get-DatabaseServiceExecutable $service.PathName) -ne $Receipt.executable) { throw 'Service ownership does not match this Manager installation' }
    return $service
}

function Assert-OfflineServiceHealth($Receipt) {
    $service = Assert-ServiceOwnership $Receipt
    if ($service.State -ne 'Running' -or $service.StartMode -ne 'Auto' -or $service.ProcessId -le 0) { throw ($Receipt.service + ' must be running with automatic startup') }
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='mysqld.exe' OR Name='mariadbd.exe' OR Name='mongod.exe' OR Name='sqlservr.exe'")
    $owned = @(Get-DatabaseListenerProcessIds $service.ProcessId $Receipt.executable $processes)
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $owned -contains [int]$_.OwningProcess })
    if (-not @($listeners | Where-Object { $_.LocalPort -eq $Receipt.port }).Count) { throw 'Service has not opened its configured port' }
    if (@($listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1','::1') }).Count) { throw 'Service has an unexpected network-facing listener' }
}

function Wait-OfflineServiceHealth($Receipt) {
    $last = ''
    for ($attempt=0; $attempt -lt 60; $attempt++) {
        try { Assert-OfflineServiceHealth $Receipt; return } catch { $last=$_.Exception.Message }
        Start-Sleep -Seconds 1
    }
    throw $last
}

function Invoke-ServiceProbe($Context,[string]$Mode) {
    & $Context.Node (Join-Path $PSScriptRoot 'offline-service-check.cjs') $Mode $Context.StateRoot
    if ($LASTEXITCODE -ne 0) { throw 'Database authentication or persistence verification failed; inspect the service log' }
}

function Enable-OfflineSqlTcp([string]$InstanceId,[int]$Port) {
    $tcp = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\' + $InstanceId + '\MSSQLServer\SuperSocketNetLib\Tcp'
    if (-not (Test-Path -LiteralPath $tcp)) { throw 'SQL Server instance TCP configuration was not created' }
    Set-ItemProperty -LiteralPath $tcp -Name Enabled -Value 1
    Set-ItemProperty -LiteralPath $tcp -Name ListenOnAllIPs -Value 0
    $loopback = $false
    foreach ($ip in Get-ChildItem -LiteralPath $tcp | Where-Object { $_.PSChildName -match '^IP\d+$' }) {
        $address = (Get-ItemProperty -LiteralPath $ip.PSPath).IpAddress
        $enabled = [int]($address -eq '127.0.0.1')
        if ($enabled) { $loopback=$true }
        Set-ItemProperty -LiteralPath $ip.PSPath -Name Enabled -Value $enabled
        Set-ItemProperty -LiteralPath $ip.PSPath -Name TcpDynamicPorts -Value ''
        Set-ItemProperty -LiteralPath $ip.PSPath -Name TcpPort -Value ([string]$Port)
    }
    if (-not $loopback) { throw 'SQL Server did not register a loopback TCP endpoint' }
}

function Install-OfflinePhpMyAdmin($Context) {
    $package = Read-ServicePackage $Context.Bundle 'phpmyadmin'
    $php = Read-ServicePackage $Context.Bundle 'php'
    $target = Join-Path $Context.DataRoot 'services\phpmyadmin'
    $phpRoot = Join-Path $Context.DataRoot 'services\php'
    foreach ($pair in @(@($package,$target),@($php,$phpRoot))) {
        $marker = Join-Path $pair[1] '.package-sha256'
        if (Test-Path -LiteralPath $pair[1]) {
            if (-not (Test-Path -LiteralPath $marker) -or (Get-Content -LiteralPath $marker -Raw).Trim() -ne $pair[0].Item.sha256) { throw 'Existing phpMyAdmin/PHP files do not match this bundle; no files were overwritten' }
        } else {
            Protect-ServiceDirectory $pair[1]
            Expand-ManagerOfflineArchive $pair[0].File $pair[1]
            Set-Content -LiteralPath $marker -Value $pair[0].Item.sha256 -Encoding ASCII
        }
    }
    $ini = (Get-Content -LiteralPath (Join-Path $phpRoot 'php.ini-production') -Raw).Replace(';extension_dir = "ext"',('extension_dir = "' + (Join-Path $phpRoot 'ext').Replace('\','/') + '"'))
    foreach ($extension in @('mysqli','mbstring','openssl','curl','fileinfo','zip')) { $ini = $ini -replace ('(?m)^;extension=' + $extension + '\s*$'),('extension=' + $extension) }
    [IO.File]::WriteAllText((Join-Path $phpRoot 'php.ini'),$ini,[Text.UTF8Encoding]::new($false))
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'offline-phpmyadmin.inc.php') -Destination (Join-Path $target 'config.inc.php') -Force
    # The setup UI can change server configuration and is not needed by Manager.
    $setup = [IO.Path]::GetFullPath((Join-Path $target 'setup'))
    if (-not $setup.StartsWith([IO.Path]::GetFullPath($target).TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe setup directory' }
    if (Test-Path -LiteralPath $setup) { Remove-Item -LiteralPath $setup -Recurse -Force }
    & (Join-Path $phpRoot 'php.exe') (Join-Path $PSScriptRoot 'offline-php-check.php')
    if ($LASTEXITCODE -ne 0) { throw 'Bundled PHP extension verification failed' }
    Set-Content -LiteralPath (Join-Path $target 'VERSION') -Value $package.Item.version -Encoding ASCII
    Write-Host '[offline] phpMyAdmin files and PHP extensions verified'
}

function Install-OfflineDatabase($Context) {
    $spec = Get-OfflineServiceSpec $Context.Engine
    $package = Read-ServicePackage $Context.Bundle $Context.Engine
    $vc = Read-ServicePackage $Context.Bundle 'vcredist'
    $sqlUpdate = if ($Context.Engine -eq 'sqlserver') { Read-ServicePackage $Context.Bundle 'sqlserver-update' } else { $null }
    $stateFile = Join-Path $Context.StateRoot 'service.json'
    $binaryRoot = Join-Path $Context.StateRoot 'runtime'
    $data = Join-Path $Context.StateRoot 'data'
    $config = Join-Path $Context.StateRoot 'server.conf'
    $existingService = Get-CimInstance Win32_Service -Filter ("Name='"+$spec.Service+"'")
    if (Test-Path -LiteralPath $stateFile) {
        $receipt = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
        if ($sqlUpdate -and $receipt.sqlUpdateSha256 -ne $sqlUpdate.Item.sha256) { throw 'SQL Server update does not match the installed receipt; automatic database upgrades are disabled' }
        if ($receipt.engine -ne $Context.Engine -or $receipt.packageSha256 -ne $package.Item.sha256 -or $receipt.service -ne $spec.Service -or $receipt.port -ne $spec.Port -or $receipt.executable -ne (Join-Path $binaryRoot $spec.Binary)) { throw 'Installed service does not match this package. Automatic database upgrades are disabled.' }
        if ($existingService) { $null = Assert-ServiceOwnership $receipt }
        if ($receipt.phase -eq 'initializing') { throw 'A previous initialization was interrupted. Preserve the data directory and inspect its error log; it will not be initialized again.' }
        $credential = Read-ServiceCredential $Context.StateRoot
    } else {
        if ($existingService -or (Test-Path -LiteralPath $Context.StateRoot)) { throw 'Service or data directory already exists without a matching Manager receipt; nothing was replaced' }
        if ($Context.Engine -eq 'sqlserver' -and @(Get-CimInstance Win32_Service -Filter "Name='MSSQLSERVER' OR Name LIKE 'MSSQL$%'").Count) { throw 'An existing SQL Server instance uses shared SQL components. Connect that instance instead of installing another one.' }
        if (Get-NetTCPConnection -State Listen -LocalPort $spec.Port -ErrorAction SilentlyContinue) { throw ('Port ' + $spec.Port + ' is occupied. Connect the existing database instead of installing another instance.') }
        Protect-ServiceDirectory $Context.StateRoot
        $credential = New-ServiceCredential $Context.StateRoot $spec.User
        $receipt = [ordered]@{engine=$Context.Engine;version=$package.Item.version;packageSha256=$package.Item.sha256;service=$spec.Service;port=$spec.Port;executable=(Join-Path $binaryRoot $spec.Binary);phase='prepared';verificationToken=[guid]::NewGuid().ToString('N')}
        if ($sqlUpdate) { $receipt.sqlUpdateSha256=$sqlUpdate.Item.sha256; $receipt.sqlVersion=$sqlUpdate.Item.version; $receipt.version='2022 ('+$sqlUpdate.Item.version+')' }
        Write-ServiceJson $stateFile $receipt
    }
    $ownedPids = if ($existingService) { @(Get-DatabaseListenerProcessIds $existingService.ProcessId $receipt.executable @(Get-CimInstance Win32_Process -Filter "Name='mysqld.exe' OR Name='mariadbd.exe' OR Name='mongod.exe' OR Name='sqlservr.exe'")) } else { @() }
    if (@(Get-NetTCPConnection -State Listen -LocalPort $spec.Port -ErrorAction SilentlyContinue | Where-Object { $ownedPids -notcontains [int]$_.OwningProcess }).Count) { throw 'Database port belongs to another process' }
    if ($receipt.phase -eq 'ready') { Assert-OfflineServiceHealth $receipt; Invoke-ServiceProbe $Context 'verify'; return }
    Invoke-ManagerOfflineSetup $vc.File @('/install','/quiet','/norestart') @(0,3010,1638)
    if (-not (Test-Path -LiteralPath $binaryRoot)) {
        if ($Context.Engine -eq 'sqlserver') {
            New-Item -ItemType Directory -Path $binaryRoot | Out-Null
        } else { Expand-ManagerOfflineArchive $package.File $binaryRoot }
    }
    try {
        if ($receipt.phase -eq 'prepared') {
            $receipt.phase='initializing'; Write-ServiceJson $stateFile $receipt
            if ($Context.Engine -in @('mysql','mariadb')) {
                if (Test-Path -LiteralPath $data) { throw 'Database data directory already exists; it will not be initialized again' }
                if ($Context.Engine -eq 'mysql') {
                    Invoke-DatabaseNative $receipt.executable @('--no-defaults','--initialize-insecure',('--basedir='+$binaryRoot),('--datadir='+$data)) 'Initialize bundled MySQL'
                } else {
                    Invoke-DatabaseNative (Join-Path $binaryRoot 'bin\mariadb-install-db.exe') @(('--datadir='+$data)) 'Initialize bundled MariaDB'
                }
                $configuration = "[mysqld]`r`nbasedir=" + $binaryRoot.Replace('\','/') + "`r`ndatadir=" + $data.Replace('\','/') + "`r`nport=" + $spec.Port + "`r`nbind-address=127.0.0.1`r`nskip-name-resolve`r`n"
                if ($Context.Engine -eq 'mysql') { $configuration += "mysqlx=OFF`r`n" }
                [IO.File]::WriteAllText($config,$configuration,[Text.UTF8Encoding]::new($false))
                $initFile = Join-Path $Context.StateRoot 'bootstrap.sql'
                $secret=$credential.password; $user=$credential.username
                # All generated secrets are alphanumeric plus !; no caller SQL is accepted.
                $sql = "CREATE USER IF NOT EXISTS '$user'@'localhost' IDENTIFIED BY '$secret';`r`nGRANT ALL PRIVILEGES ON *.* TO '$user'@'localhost' WITH GRANT OPTION;`r`nCREATE USER IF NOT EXISTS '$user'@'127.0.0.1' IDENTIFIED BY '$secret';`r`nGRANT ALL PRIVILEGES ON *.* TO '$user'@'127.0.0.1' WITH GRANT OPTION;`r`nALTER USER 'root'@'localhost' IDENTIFIED BY '$secret';`r`n"
                if ($Context.Engine -eq 'mariadb') { $sql += "DELETE FROM mysql.global_priv WHERE User='';`r`nFLUSH PRIVILEGES;`r`n" }
                [IO.File]::WriteAllText($initFile,$sql,[Text.UTF8Encoding]::new($false))
                Add-Content -LiteralPath $config -Value ('init-file=' + $initFile.Replace('\','/')) -Encoding ASCII
                Invoke-DatabaseNative $receipt.executable @('--install',$spec.Service,('--defaults-file='+$config)) 'Register bundled database service'
            } elseif ($Context.Engine -eq 'mongodb') {
                New-Item -ItemType Directory -Path $data | Out-Null
                $settings = @{storage=@{dbPath=$data};systemLog=@{destination='file';path=(Join-Path $Context.StateRoot 'mongodb.log');logAppend=$true};net=@{bindIp='127.0.0.1';port=$spec.Port};security=@{authorization='enabled'}}
                # JSON is a YAML subset accepted by mongod.
                Write-ServiceJson $config $settings
                Invoke-DatabaseNative $receipt.executable @('--config',$config,'--install','--serviceName',$spec.Service,'--serviceDisplayName','Manager MongoDB') 'Register bundled MongoDB service'
            } else {
                $setupRoot=Join-Path $Context.StateRoot 'setup'
                Invoke-ManagerOfflineSetup $package.File @('/Q',('/x:"'+$setupRoot+'"')) @(0)
                $setupConfig=Join-Path $Context.StateRoot 'sql-setup.ini'
                $adminGroup=([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')).Translate([Security.Principal.NTAccount]).Value
                $settings=@('[OPTIONS]','ACTION="Install"','QUIET="True"','IACCEPTSQLSERVERLICENSETERMS="True"','FEATURES="SQLENGINE"','INSTANCENAME="MANAGER"','INSTANCEID="MANAGER"',('INSTANCEDIR="'+$binaryRoot+'"'),'UPDATEENABLED="False"','USEMICROSOFTUPDATE="False"','TCPENABLED="0"','NPENABLED="0"','SECURITYMODE="SQL"',('SAPWD="'+$credential.password+'"'),('SQLSYSADMINACCOUNTS="'+$adminGroup+'"'),'SQLSVCSTARTUPTYPE="Automatic"','BROWSERSVCSTARTUPTYPE="Disabled"')
                [IO.File]::WriteAllLines($setupConfig,$settings,[Text.UTF8Encoding]::new($false))
                try { Invoke-ManagerOfflineSetup (Join-Path $setupRoot 'setup.exe') @('/Q',('/ConfigurationFile="'+$setupConfig+'"')) @(0,3010) }
                finally { Remove-Item -LiteralPath $setupConfig -Force -ErrorAction SilentlyContinue }
                Invoke-ManagerOfflineSetup $sqlUpdate.File @('/quiet','/IAcceptSQLServerLicenseTerms','/Action=Patch','/InstanceName=MANAGER') @(0,3010)
                Enable-OfflineSqlTcp 'MSSQL16.MANAGER' $spec.Port
            }
            $receipt.phase='initialized'; Write-ServiceJson $stateFile $receipt
        }
        $service = Assert-ServiceOwnership $receipt
        Set-Service -Name $spec.Service -StartupType Automatic
        if ($service.State -eq 'Running') { Restart-Service -Name $spec.Service } else { Start-Service -Name $spec.Service }
        Wait-OfflineServiceHealth $receipt
        Invoke-ServiceProbe $Context 'initialize'
        if ($Context.Engine -in @('mysql','mariadb')) {
            $clean = [regex]::Replace([IO.File]::ReadAllText($config),'(?m)^init-file=.*\r?\n?','')
            [IO.File]::WriteAllText($config,$clean,[Text.UTF8Encoding]::new($false))
            Remove-Item -LiteralPath (Join-Path $Context.StateRoot 'bootstrap.sql') -Force -ErrorAction SilentlyContinue
        }
        # Verify a fresh process with the durable config and the saved credential.
        Restart-Service -Name $spec.Service
        Wait-OfflineServiceHealth $receipt
        Invoke-ServiceProbe $Context 'verify'
        $receipt.phase='ready'; Write-ServiceJson $stateFile $receipt
        Write-Host ('[PASS] '+$Context.Engine+' authenticated query and persisted marker survived service restart; automatic startup enabled')
    } catch {
        # Leave files and credentials for diagnosis, and stop only our own instance.
        try { $null=Assert-ServiceOwnership $receipt; Stop-Service -Name $spec.Service -ErrorAction Stop } catch { Write-Warning 'Check the Manager service state before retrying; existing databases were not removed.' }
        throw
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    if (-not $ManagerRoot) { $ManagerRoot=Split-Path -Parent $PSScriptRoot }
    $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
    $env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+$env:PSModulePath
    if (-not $Engine) { throw 'Choose a service with -Engine' }
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Offline service operations require an administrator or SYSTEM account' }
    $stateRoot=Join-Path $DataRoot ('services\'+$Engine)
    if ($Action -eq 'Credential') { Read-ServiceCredential $stateRoot | ConvertTo-Json -Compress; exit 0 }
    $boot=Get-Content -LiteralPath (Join-Path $DataRoot 'pm2-startup.json') -Raw | ConvertFrom-Json
    $context=@{DataRoot=$DataRoot;StateRoot=$stateRoot;Engine=$Engine;Node=$boot.node;ManagerRoot=$ManagerRoot;Bundle=(Join-Path $DataRoot 'offline-services')}
    if ($Action -eq 'Verify') {
        $receipt=Get-Content -LiteralPath (Join-Path $stateRoot 'service.json') -Raw | ConvertFrom-Json
        if ($receipt.phase -ne 'ready') { throw 'Service installation is incomplete; inspect its installation log before verification' }
        Assert-OfflineServiceHealth $receipt
        Invoke-ServiceProbe $context 'verify'
        Write-Host ('[PASS] '+$Engine+' automatic service, loopback listener, credentials and persisted data verified')
    } elseif ($Engine -eq 'phpmyadmin') { Install-OfflinePhpMyAdmin $context }
    else { Install-OfflineDatabase $context }
}
