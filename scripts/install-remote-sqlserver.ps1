# Dot-sourced by the reviewed Windows service installer. Helpers and assets are
# in its administrator-owned staging directory, never an application directory.
function Install-RemoteSqlServer($Plan, [string]$Target, [string]$Stage, [string]$Node, [string]$PlanFile) {
    if (@(Get-CimInstance Win32_Service -Filter "Name='MSSQLSERVER' OR Name LIKE 'MSSQL$%'").Count) { throw 'An existing SQL Server instance uses shared components. Reuse it instead.' }
    if ($Plan.databasePassword -notmatch '^Mg!A1[a-f0-9]{72}$') { throw 'Invalid SQL Server installation credential' }
    foreach ($existing in @((Join-Path $env:ProgramFiles 'Microsoft SQL Server\MSSQL16.MANAGER'),(Join-Path $Target 'runtime'))) {
        if (Test-Path -LiteralPath $existing) { throw 'Existing SQL Server files were found. Inspect or reuse the installation; nothing was replaced.' }
    }
    # Reuse the hardened offline installer's signature, TCP and ownership checks.
    . (Join-Path $Stage 'offline-service.ps1')
    $vc=Join-Path $Target 'vcredist.exe';$package=Join-Path $Target 'sql-express.exe';$update=Join-Path $Target 'sql-update.exe'
    Fetch-Verified $Plan.downloads.vcredist $vc
    Fetch-Verified $Plan.downloads.sqlserver $package
    Fetch-Verified $Plan.downloads.'sqlserver-update' $update
    Invoke-ManagerOfflineSetup $vc @('/install','/quiet','/norestart') @(0,3010,1638)
    $setupRoot=Join-Path $Target 'setup';$binaryRoot=Join-Path $Target 'runtime'
    Invoke-ManagerOfflineSetup $package @('/Q',('/x:"'+$setupRoot+'"')) @(0)
    $setupConfig=Join-Path $Stage 'sql-setup.ini'
    $adminGroup=([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')).Translate([Security.Principal.NTAccount]).Value
    $settings=@('[OPTIONS]','ACTION="Install"','QUIET="True"','IACCEPTSQLSERVERLICENSETERMS="True"','FEATURES="SQLENGINE"','INSTANCENAME="MANAGER"','INSTANCEID="MANAGER"',('INSTANCEDIR="'+$binaryRoot+'"'),'UPDATEENABLED="False"','USEMICROSOFTUPDATE="False"','TCPENABLED="0"','NPENABLED="0"','SECURITYMODE="SQL"',('SAPWD="'+$Plan.databasePassword+'"'),('SQLSYSADMINACCOUNTS="'+$adminGroup+'"'),'SQLSVCSTARTUPTYPE="Automatic"','BROWSERSVCSTARTUPTYPE="Disabled"')
    [IO.File]::WriteAllLines($setupConfig,$settings,[Text.UTF8Encoding]::new($false))
    try { Invoke-ManagerOfflineSetup (Join-Path $setupRoot 'setup.exe') @('/Q',('/ConfigurationFile="'+$setupConfig+'"')) @(0,3010) }
    finally { Remove-Item -LiteralPath $setupConfig -Force -ErrorAction SilentlyContinue }
    $receipt=@{service='MSSQL$MANAGER';port=$Plan.port;executable=(Join-Path $binaryRoot 'MSSQL16.MANAGER\MSSQL\Binn\sqlservr.exe')}
    $null=Assert-ServiceOwnership $receipt
    Run 'icacls.exe' @($Target,'/grant','NT SERVICE\MSSQL$MANAGER:(OI)(CI)RX') | Out-Host
    Invoke-ManagerOfflineSetup $update @('/quiet','/IAcceptSQLServerLicenseTerms','/Action=Patch','/InstanceName=MANAGER') @(0,3010)
    Enable-OfflineSqlTcp 'MSSQL16.MANAGER' $Plan.port
    Set-Service -Name $receipt.service -StartupType Automatic
    Restart-Service -Name $receipt.service
    Wait-OfflineServiceHealth $receipt
    Run $Node @((Join-Path $Stage 'initialize-remote-database.cjs'),$PlanFile,'initialize') | Out-Host
    Restart-Service -Name $receipt.service
    Wait-OfflineServiceHealth $receipt
    Run $Node @((Join-Path $Stage 'initialize-remote-database.cjs'),$PlanFile,'verify') | Out-Host
    $client=Join-Path $Target 'client';$zip=Join-Path $Target 'sqlcmd.zip'
    Fetch-Verified $Plan.downloads.sqlcmd $zip
    Extract-Database $zip $client -All
    $exe=Join-Path $client 'sqlcmd.exe';Run $exe @('--version') | Out-Host
    Remove-Item -LiteralPath $vc,$package,$update,$zip -Force
    return @{path=$exe;serviceName=$receipt.service;dataPath=(Join-Path $binaryRoot 'MSSQL16.MANAGER\MSSQL\DATA');username='sa'}
}
