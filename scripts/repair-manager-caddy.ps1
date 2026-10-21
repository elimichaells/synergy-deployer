[CmdletBinding()]
param([switch]$Apply, [switch]$VerifyOnly)

# Repair an installed Manager 2.19.x host; never rerun the fresh installer.
function Invoke-CaddyRepairNative([string]$File, [string[]]$Arguments) {
    $output = & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw ([IO.Path]::GetFileName($File) + ' failed with exit code ' + $LASTEXITCODE) }
    return $output
}

function Get-CaddyRepairPm2($Context) {
    $result = Invoke-CaddyRepairNative $Context.Boot.node @($Context.Helper,'pm2',$Context.Root)
    return ($result -join "`n") | ConvertFrom-Json
}

function Assert-CaddyRepairHealth($Context) {
    $process = Get-CaddyRepairPm2 $Context
    if ($process.status -ne 'online' -or $process.pid -le 0) { throw 'Manager Caddy is not online in PM2' }
    foreach ($port in @(80,443,2019,8081)) {
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
        if (-not $listeners.Count -or @($listeners | Where-Object { $_.OwningProcess -ne $process.pid }).Count) {
            throw ('Manager Caddy does not own every listener on port ' + $port)
        }
    }
    $actual = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $process.pid)
    if (-not $actual -or $actual.ExecutablePath -ne $Context.Exe) { throw 'Listening Caddy executable does not match Manager' }
    $null = Invoke-CaddyRepairNative $Context.Boot.node @($Context.Helper,'https',$Context.Root)
}

function Wait-CaddyRepairHealth($Context) {
    $lastFailure = ''
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        try { Assert-CaddyRepairHealth $Context; return } catch { $lastFailure = $_.Exception.Message }
        Start-Sleep -Seconds 2
    }
    throw ('Caddy verification failed: ' + $lastFailure)
}

function Invoke-CaddyRepairSwitch($Context) {
    $legacy = Get-CimInstance Win32_Service -Filter "Name = 'Caddy'"
    if (-not $legacy -or $legacy.State -ne 'Running' -or $legacy.StartMode -ne 'Auto' -or
        $legacy.PathName -notmatch '^\s*"?C:\\Caddy\\caddy\.exe"?\s+run\s+--config\s+"?C:\\Caddy\\Caddyfile"?\s*$') {
        throw 'The expected automatic C:\Caddy Windows service was not found running. No service changes were made.'
    }
    $admin = @(Get-NetTCPConnection -State Listen -LocalPort 2019 -ErrorAction Stop)
    if (-not $admin.Count -or @($admin | Where-Object { $_.OwningProcess -ne $legacy.ProcessId }).Count) { throw 'Port 2019 belongs to an unexpected process' }
    $null = Get-CaddyRepairPm2 $Context
    $delayedStart = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Services\Caddy' -Name DelayedAutoStart -ErrorAction SilentlyContinue).DelayedAutoStart
    $original = [IO.File]::ReadAllText($Context.Config)
    $import = 'import "C:/Caddy/Caddyfile"'
    if ($original.Contains($import)) { throw 'Legacy import already exists. Use -VerifyOnly or inspect the previous repair before retrying.' }

    $backup = Join-Path $Context.Root ('Recovery\caddy-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    $null = Invoke-CaddyRepairNative 'icacls.exe' @($backup,'/inheritance:r','/grant:r','*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F')
    Copy-Item -LiteralPath $Context.Config -Destination (Join-Path $backup 'Manager.Caddyfile')
    Copy-Item -LiteralPath 'C:\Caddy\Caddyfile' -Destination (Join-Path $backup 'Legacy.Caddyfile')
    Copy-Item -LiteralPath (Join-Path $Context.Root 'pm2\dump.pm2') -Destination (Join-Path $backup 'dump.pm2')
    $legacy | Select-Object Name,State,StartMode,PathName,@{Name='DelayedAutoStart';Expression={$delayedStart}} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backup 'service.json') -Encoding UTF8
    # Manager may have reloaded the old service through its admin API. Preserve
    # both its on-disk config and its actual running config for rollback.
    $active = Invoke-WebRequest -Uri 'http://127.0.0.1:2019/config/' -UseBasicParsing -TimeoutSec 5
    [IO.File]::WriteAllText((Join-Path $backup 'Legacy.active.json'),$active.Content,[Text.UTF8Encoding]::new($false))
    $candidate = Join-Path $backup 'Combined.Caddyfile'
    [IO.File]::WriteAllText($candidate,($import + "`r`n`r`n" + $original),[Text.UTF8Encoding]::new($false))
    # Validate from the web root so existing relative paths retain their meaning.
    Push-Location $Context.Report.webRoot
    try {
        $null = Invoke-CaddyRepairNative $Context.Exe @('validate','--config',$candidate,'--adapter','caddyfile')
        $adapted = (Invoke-CaddyRepairNative $Context.Exe @('adapt','--config',$candidate,'--adapter','caddyfile')) -join "`n" | ConvertFrom-Json
        $ports = @($adapted.apps.http.servers.PSObject.Properties | ForEach-Object { $_.Value.listen })
        if (-not @($ports | Where-Object { $_ -match ':8081$' }).Count -or -not @($ports | Where-Object { $_ -match ':443$' }).Count) {
            throw 'Combined configuration must retain port 8081 and Manager HTTPS on 443'
        }
        if ($adapted.admin.disabled -or ($adapted.admin.listen -and $adapted.admin.listen -notin @('localhost:2019','127.0.0.1:2019'))) { throw 'Unexpected Caddy administration endpoint' }
        Write-Host ('Validated combined configuration. Backup: ' + $backup)
        $serviceStopped = $false
        $managerStarted = $false
        try {
            # Prevent Manager startup reconciliation from rewriting the file mid-switch.
            $managerHash = (Get-FileHash -LiteralPath $Context.Config -Algorithm SHA256).Hash
            if ($managerHash -ne (Get-FileHash -LiteralPath (Join-Path $backup 'Manager.Caddyfile') -Algorithm SHA256).Hash) { throw 'Manager configuration changed during preparation; retry after it settles' }
            Stop-Service -Name 'Caddy' -ErrorAction Stop
            $serviceStopped = $true
            if (Get-NetTCPConnection -State Listen -LocalPort 80,443,2019,8081 -ErrorAction SilentlyContinue) { throw 'A conflicting listener remains after stopping the legacy service' }
            Copy-Item -LiteralPath $candidate -Destination $Context.Config -Force
            $managerStarted = $true
            $null = Invoke-CaddyRepairNative $Context.Boot.pm2 @('restart','manager-caddy','--update-env')
            Wait-CaddyRepairHealth $Context
            Start-Sleep -Seconds 3
            Assert-CaddyRepairHealth $Context
            # Disable the old boot entry and save PM2 only after verified HTTPS.
            Set-Service -Name 'Caddy' -StartupType Disabled -ErrorAction Stop
            $null = Invoke-CaddyRepairNative $Context.Boot.pm2 @('save')
        } catch {
            $failure = $_.Exception.Message
            $rollbackErrors = @()
            if ($managerStarted) {
                try { $null = Invoke-CaddyRepairNative $Context.Boot.pm2 @('stop','manager-caddy') } catch { $rollbackErrors += $_.Exception.Message }
            }
            if ($serviceStopped) {
                try {
                    Copy-Item -LiteralPath (Join-Path $backup 'Manager.Caddyfile') -Destination $Context.Config -Force
                    Copy-Item -LiteralPath (Join-Path $backup 'dump.pm2') -Destination (Join-Path $Context.Root 'pm2\dump.pm2') -Force
                    Set-Service -Name 'Caddy' -StartupType Automatic -ErrorAction Stop
                    if ($delayedStart) { $null = Invoke-CaddyRepairNative 'sc.exe' @('config','Caddy','start=','delayed-auto') }
                    Start-Service -Name 'Caddy' -ErrorAction Stop
                    for ($retry=0; $retry -lt 20; $retry++) {
                        $restoredService = Get-CimInstance Win32_Service -Filter "Name = 'Caddy'"
                        $restoredAdmin = @(Get-NetTCPConnection -State Listen -LocalPort 2019 -ErrorAction SilentlyContinue)
                        if ($restoredAdmin.Count -and -not @($restoredAdmin | Where-Object { $_.OwningProcess -ne $restoredService.ProcessId }).Count) { break }
                        Start-Sleep -Seconds 1
                    }
                    if (-not $restoredAdmin.Count -or @($restoredAdmin | Where-Object { $_.OwningProcess -ne $restoredService.ProcessId }).Count) { throw 'The restored legacy service administration endpoint did not become ready' }
                    $null = Invoke-CaddyRepairNative 'C:\Caddy\caddy.exe' @('reload','--config',(Join-Path $backup 'Legacy.active.json'),'--address','127.0.0.1:2019')
                } catch { $rollbackErrors += $_.Exception.Message }
            }
            if ($rollbackErrors.Count) { throw ($failure + '. Rollback needs attention: ' + ($rollbackErrors -join '; ') + '. Backup: ' + $backup) }
            throw ($failure + '. Previous service and configuration restored. Backup: ' + $backup)
        }
    } finally { Pop-Location }
    Write-Host 'PASS: Manager Caddy owns ports 80, 443, 2019 and 8081; HTTPS login and its certificate verified. Legacy service disabled; PM2 startup state saved.'
}

if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'
    $env:PSModulePath = (Join-Path $PSHOME 'Modules') + ';' + $env:PSModulePath
    $ProgressPreference = 'SilentlyContinue'
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this repair from an administrator PowerShell window' }
    if ($Apply -eq $VerifyOnly) { throw 'Choose -Apply to perform the repair or -VerifyOnly to check it after reboot' }
    $root = Join-Path $env:ProgramData 'Manager'
    $boot = Get-Content -LiteralPath (Join-Path $root 'pm2-startup.json') -Raw | ConvertFrom-Json
    $report = Get-Content -LiteralPath (Join-Path $root 'install-report.json') -Raw | ConvertFrom-Json
    $context = [pscustomobject]@{Root=$root;Boot=$boot;Report=$report;Helper=(Join-Path $PSScriptRoot 'caddy-repair-check.cjs');Exe=(Join-Path $report.webRoot 'caddy.exe');Config=(Join-Path $report.webRoot 'Caddyfile')}
    foreach ($file in @($boot.node,$boot.pm2,$context.Helper,$context.Exe,$context.Config,'C:\Caddy\Caddyfile')) { if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw ('Required file is missing: ' + $file) } }
    $env:PM2_HOME = Join-Path $root 'pm2'
    $env:Path = (Split-Path -Parent $boot.node) + ';' + (Split-Path -Parent $boot.pm2) + ';' + $boot.path
    $env:XDG_DATA_HOME = $boot.caddyDataHome
    $env:XDG_CONFIG_HOME = $boot.caddyConfigHome
    if ($VerifyOnly) {
        Assert-CaddyRepairHealth $context
        $old = Get-CimInstance Win32_Service -Filter "Name = 'Caddy'"
        if ($old.State -ne 'Stopped' -or $old.StartMode -ne 'Disabled') { throw 'The legacy Caddy service is not stopped and disabled' }
        Write-Host 'PASS: Manager Caddy owns all four ports; HTTPS login and certificate verified; legacy Caddy remains disabled.'
    } else { Invoke-CaddyRepairSwitch $context }
}
