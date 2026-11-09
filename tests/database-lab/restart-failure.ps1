param([Parameter(Mandatory=$true)][ValidateSet('mysql','mariadb')][string]$Engine,
      [Parameter(Mandatory=$true)][string]$ServiceName)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:MANAGER_DATABASE_LAB -ne '1' -or $env:RUNNER_OS -ne 'Windows'){throw 'Restart fault injection requires the disposable database lab'}
$inventory=Get-Content -LiteralPath 'C:\ManagerDatabaseLab\private\instances.json' -Raw | ConvertFrom-Json
if($inventory.computer -ne $env:COMPUTERNAME){throw 'Wrong disposable computer'}
$instance=@($inventory.instances | Where-Object {$_.name -eq $ServiceName -and $_.provider -eq $Engine -and $_.name -match '^ManagerLab(MySQL|MariaDB)Target$'})
if($instance.Count -ne 1){throw 'Fault injection only permits the two disposable target services'}
$global:ManagerLabRestartFault=@{injected=$false;service=$ServiceName}
function Restart-Service([string]$Name) {
    if($Name -ne $global:ManagerLabRestartFault.service){throw 'Unexpected service in fault injection'}
    if($global:ManagerLabRestartFault.injected){Microsoft.PowerShell.Management\Restart-Service -Name $Name -ErrorAction Stop;return}
    $global:ManagerLabRestartFault.injected=$true
    # Stop the real disposable service, then inject a start failure. Recovery
    # must restore the bytes and start the actual service through SCM.
    Microsoft.PowerShell.Management\Stop-Service -Name $Name -ErrorAction Stop
    throw 'Injected failure after stopping the disposable database service'
}
& (Join-Path $PSScriptRoot '..\..\scripts\tune-database-memory.ps1') -Engine $Engine -ServiceName $ServiceName -Settings 'performance_schema=ON'
throw 'Expected tuning to report its failed restart and successful rollback'
