param([Parameter(Mandatory=$true)][ValidateSet('mysql','mariadb')][string]$Engine,
      [Parameter(Mandatory=$true)][string]$ServiceName)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:MANAGER_DATABASE_LAB -ne '1' -or $env:RUNNER_OS -ne 'Windows'){throw 'Restart fault injection requires the disposable database lab'}
$inventory=Get-Content -LiteralPath 'C:\ManagerDatabaseLab\private\instances.json' -Raw | ConvertFrom-Json
if($inventory.computer -ne $env:COMPUTERNAME){throw 'Wrong disposable computer'}
$instance=@($inventory.instances | Where-Object {$_.name -eq $ServiceName -and $_.provider -eq $Engine -and $_.name -match '^ManagerLab(MySQL|MariaDB)Target$'})
if($instance.Count -ne 1){throw 'Fault injection only permits the two disposable target services'}
$script:injected=$false
$script:expectedService=$ServiceName
function Restart-Service([string]$Name) {
    if($Name -ne $script:expectedService){throw 'Unexpected service in fault injection'}
    if($script:injected){Microsoft.PowerShell.Management\Restart-Service -Name $Name -ErrorAction Stop;return}
    $script:injected=$true
    $key='HKLM:\SYSTEM\CurrentControlSet\Services\'+$Name
    $original=(Get-ItemProperty -LiteralPath $key).ImagePath
    # Temporarily make the first real SCM start fail. Restore its registration
    # before the tuning script attempts its normal configuration rollback.
    try {
        Microsoft.PowerShell.Management\Stop-Service -Name $Name -ErrorAction Stop
        Set-ItemProperty -LiteralPath $key -Name ImagePath -Value ($original+' --manager-lab-invalid-option')
        Microsoft.PowerShell.Management\Start-Service -Name $Name -ErrorAction Stop
        throw 'Fault injection unexpectedly allowed the service to start'
    } finally {Set-ItemProperty -LiteralPath $key -Name ImagePath -Value $original}
}
& (Join-Path $PSScriptRoot '..\..\scripts\tune-database-memory.ps1') -Engine $Engine -ServiceName $ServiceName -Settings 'performance_schema=ON'
throw 'Expected tuning to report its failed restart and successful rollback'
