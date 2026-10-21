[CmdletBinding()]
param([switch]$Apply, [switch]$VerifyOnly, [switch]$RetireTestSite)

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
    $requiredPorts = @(80,443,2019)
    if (-not $Context.RetireTestSite) { $requiredPorts += 8081 }
    foreach ($port in $requiredPorts) {
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
        if (-not $listeners.Count -or @($listeners | Where-Object { $_.OwningProcess -ne $process.pid }).Count) {
            throw ('Manager Caddy does not own every listener on port ' + $port)
        }
    }
    if ($Context.RetireTestSite -and @(Get-NetTCPConnection -State Listen -LocalPort 8081 -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $process.pid }).Count) {
        throw 'Manager Caddy is still serving the retired test site on port 8081'
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
    if (-not $legacy -or
        $legacy.PathName -notmatch '^\s*"?C:\\Caddy\\caddy\.exe"?\s+run\s+--config\s+"?C:\\Caddy\\Caddyfile"?\s*$') {
        throw 'The expected C:\Caddy Windows service was not found. No service changes were made.'
    }
    $manager = Get-CaddyRepairPm2 $Context
    $legacyWasRunning = $legacy.State -eq 'Running' -and $legacy.StartMode -eq 'Auto'
    $managerWasServing = $Context.RetireTestSite -and $legacy.State -eq 'Stopped' -and $legacy.StartMode -eq 'Disabled' -and $manager.status -eq 'online' -and $manager.pid -gt 0
    if (-not $legacyWasRunning -and -not $managerWasServing) { throw 'Unexpected service state. Expected the running automatic legacy service, or an already repaired Manager with the legacy service disabled.' }
    $expectedAdminPid = if ($legacyWasRunning) { $legacy.ProcessId } else { $manager.pid }
    $admin = @(Get-NetTCPConnection -State Listen -LocalPort 2019 -ErrorAction Stop)
    if (-not $admin.Count -or @($admin | Where-Object { $_.OwningProcess -ne $expectedAdminPid }).Count) { throw 'Port 2019 belongs to an unexpected process' }
    $delayedStart = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Services\Caddy' -Name DelayedAutoStart -ErrorAction SilentlyContinue).DelayedAutoStart
    $original = [IO.File]::ReadAllText($Context.Config)
    $import = 'import "C:/Caddy/Caddyfile"'
    if ($Context.RetireTestSite) {
        # Remove only the import added by the earlier repair. Validate below that
        # no other route continues to expose the retired port.
        $candidateText = [regex]::Replace($original, '(?m)^import "C:/Caddy/Caddyfile"\r?(?:\n|$)', '')
    } else {
        if ($original.Contains($import)) { throw 'Legacy import already exists. Use -VerifyOnly or inspect the previous repair before retrying.' }
        $candidateText = $import + "`r`n`r`n" + $original
    }

    $backup = Join-Path $Context.Root ('Recovery\caddy-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    $null = Invoke-CaddyRepairNative 'icacls.exe' @($backup,'/inheritance:r','/grant:r','*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F')
    Copy-Item -LiteralPath $Context.Config -Destination (Join-Path $backup 'Manager.Caddyfile')
    Copy-Item -LiteralPath 'C:\Caddy\Caddyfile' -Destination (Join-Path $backup 'Legacy.Caddyfile')
    Copy-Item -LiteralPath (Join-Path $Context.Root 'pm2\dump.pm2') -Destination (Join-Path $backup 'dump.pm2')
    $legacy | Select-Object Name,State,StartMode,PathName,@{Name='DelayedAutoStart';Expression={$delayedStart}} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backup 'service.json') -Encoding UTF8
    # Manager may have reloaded the old service through its admin API. Preserve
    # both its on-disk config and the actual running config for rollback, even
    # when a previous repair has already transferred ownership to Manager.
    $active = Invoke-WebRequest -Uri 'http://127.0.0.1:2019/config/' -UseBasicParsing -TimeoutSec 5
    [IO.File]::WriteAllText((Join-Path $backup 'Active.json'),$active.Content,[Text.UTF8Encoding]::new($false))
    $candidate = Join-Path $backup 'Candidate.Caddyfile'
    [IO.File]::WriteAllText($candidate,$candidateText,[Text.UTF8Encoding]::new($false))
    # Validate from the web root so existing relative paths retain their meaning.
    Push-Location $Context.Report.webRoot
    try {
        $null = Invoke-CaddyRepairNative $Context.Exe @('validate','--config',$candidate,'--adapter','caddyfile')
        $adapted = (Invoke-CaddyRepairNative $Context.Exe @('adapt','--config',$candidate,'--adapter','caddyfile')) -join "`n" | ConvertFrom-Json
        $ports = @($adapted.apps.http.servers.PSObject.Properties | ForEach-Object { $_.Value.listen })
        if (-not @($ports | Where-Object { $_ -match ':443$' }).Count) { throw 'Configuration must retain Manager HTTPS on 443' }
        $hasTestPort = @($ports | Where-Object { $_ -match ':8081$' }).Count -gt 0
        if ($Context.RetireTestSite -and $hasTestPort) { throw 'Configuration still includes port 8081. No services changed; inspect the additional test-site configuration.' }
        if (-not $Context.RetireTestSite -and -not $hasTestPort) { throw 'Combined configuration must retain port 8081' }
        if ($adapted.admin.disabled -or ($adapted.admin.listen -and $adapted.admin.listen -notin @('localhost:2019','127.0.0.1:2019'))) { throw 'Unexpected Caddy administration endpoint' }
        Write-Host ('Validated Caddy configuration. Backup: ' + $backup)
        $switchAttempted = $false
        $managerStarted = $false
        try {
            # Prevent Manager startup reconciliation from rewriting the file mid-switch.
            $managerHash = (Get-FileHash -LiteralPath $Context.Config -Algorithm SHA256).Hash
            if ($managerHash -ne (Get-FileHash -LiteralPath (Join-Path $backup 'Manager.Caddyfile') -Algorithm SHA256).Hash) { throw 'Manager configuration changed during preparation; retry after it settles' }
            $switchAttempted = $true
            if ($legacyWasRunning) { Stop-Service -Name 'Caddy' -ErrorAction Stop }
            else { $null = Invoke-CaddyRepairNative $Context.Boot.pm2 @('stop','manager-caddy') }
            $requiredPorts = @(80,443,2019)
            if (-not $Context.RetireTestSite) { $requiredPorts += 8081 }
            if (Get-NetTCPConnection -State Listen -LocalPort $requiredPorts -ErrorAction SilentlyContinue) { throw 'A conflicting listener remains after stopping the previous Caddy instance' }
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
            if ($switchAttempted) {
                try {
                    Copy-Item -LiteralPath (Join-Path $backup 'Manager.Caddyfile') -Destination $Context.Config -Force
                    Copy-Item -LiteralPath (Join-Path $backup 'dump.pm2') -Destination (Join-Path $Context.Root 'pm2\dump.pm2') -Force
                    if ($legacyWasRunning) {
                        Set-Service -Name 'Caddy' -StartupType Automatic -ErrorAction Stop
                        if ($delayedStart) { $null = Invoke-CaddyRepairNative 'sc.exe' @('config','Caddy','start=','delayed-auto') }
                        Start-Service -Name 'Caddy' -ErrorAction Stop
                        $restoreExe = 'C:\Caddy\caddy.exe'
                    } else {
                        $null = Invoke-CaddyRepairNative $Context.Boot.pm2 @('restart','manager-caddy','--update-env')
                        $restoreExe = $Context.Exe
                    }
                    for ($retry=0; $retry -lt 20; $retry++) {
                        $restoredPid = if ($legacyWasRunning) { (Get-CimInstance Win32_Service -Filter "Name = 'Caddy'").ProcessId } else { (Get-CaddyRepairPm2 $Context).pid }
                        $restoredAdmin = @(Get-NetTCPConnection -State Listen -LocalPort 2019 -ErrorAction SilentlyContinue)
                        if ($restoredPid -gt 0 -and $restoredAdmin.Count -and -not @($restoredAdmin | Where-Object { $_.OwningProcess -ne $restoredPid }).Count) { break }
                        Start-Sleep -Seconds 1
                    }
                    if ($restoredPid -le 0 -or -not $restoredAdmin.Count -or @($restoredAdmin | Where-Object { $_.OwningProcess -ne $restoredPid }).Count) { throw 'The restored Caddy administration endpoint did not become ready' }
                    $null = Invoke-CaddyRepairNative $restoreExe @('reload','--config',(Join-Path $backup 'Active.json'),'--address','127.0.0.1:2019')
                } catch { $rollbackErrors += $_.Exception.Message }
            }
            if ($rollbackErrors.Count) { throw ($failure + '. Rollback needs attention: ' + ($rollbackErrors -join '; ') + '. Backup: ' + $backup) }
            throw ($failure + '. Previous service and configuration restored. Backup: ' + $backup)
        }
    } finally { Pop-Location }
    $portSummary = if ($Context.RetireTestSite) { '80, 443 and 2019; test site on 8081 retired' } else { '80, 443, 2019 and 8081' }
    Write-Host ('PASS: Manager Caddy owns ports ' + $portSummary + '; HTTPS login and its certificate verified. Legacy service disabled; PM2 startup state saved.')
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
    $context = [pscustomobject]@{Root=$root;Boot=$boot;Report=$report;Helper=(Join-Path $PSScriptRoot 'caddy-repair-check.cjs');Exe=(Join-Path $report.webRoot 'caddy.exe');Config=(Join-Path $report.webRoot 'Caddyfile');RetireTestSite=[bool]$RetireTestSite}
    foreach ($file in @($boot.node,$boot.pm2,$context.Helper,$context.Exe,$context.Config,'C:\Caddy\Caddyfile')) { if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw ('Required file is missing: ' + $file) } }
    $env:PM2_HOME = Join-Path $root 'pm2'
    $env:Path = (Split-Path -Parent $boot.node) + ';' + (Split-Path -Parent $boot.pm2) + ';' + $boot.path
    $env:XDG_DATA_HOME = $boot.caddyDataHome
    $env:XDG_CONFIG_HOME = $boot.caddyConfigHome
    if ($VerifyOnly) {
        Assert-CaddyRepairHealth $context
        $old = Get-CimInstance Win32_Service -Filter "Name = 'Caddy'"
        if ($old.State -ne 'Stopped' -or $old.StartMode -ne 'Disabled') { throw 'The legacy Caddy service is not stopped and disabled' }
        $portSummary = if ($RetireTestSite) { '80, 443 and 2019; test site on 8081 retired' } else { '80, 443, 2019 and 8081' }
        Write-Host ('PASS: Manager Caddy owns ports ' + $portSummary + '; HTTPS login and certificate verified; legacy Caddy remains disabled.')
    } else { Invoke-CaddyRepairSwitch $context }
}
