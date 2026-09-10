$ErrorActionPreference = 'Stop'
# Manager may have been launched from PowerShell 7, whose inherited module path
# omits Windows PowerShell's Security module used for signature verification.
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + ';' + $env:PSModulePath
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -Path (Join-Path $PSScriptRoot 'DeploymentDirectoryHandles.cs')
$canonicalRoot = [DeploymentDirectoryHandles]::ResolveRoot([string]$request.root)
$stopped = @()
$skipped = @()
foreach ($target in $request.candidates) {
    $current = $null
    $reason = 'ancestry'
    try {
        # Refresh before every target; never trust an old PID, command line or
        # child-process snapshot. Protect the helper and Manager ancestry.
        $rows = @(Get-CimInstance Win32_Process)
        $protectedIds = @([int]$PID, [int]$request.managerPid)
        foreach ($startId in @([int]$PID, [int]$request.managerPid)) {
            $ancestor = $rows | Where-Object ProcessId -EQ $startId | Select-Object -First 1
            if ($null -eq $ancestor) { throw 'Process ancestry unavailable' }
            $seen = @()
            while ($null -ne $ancestor -and $ancestor.ProcessId -notin $seen) {
                $seen += $ancestor.ProcessId
                $protectedIds += $ancestor.ProcessId
                $parentId = $ancestor.ParentProcessId
                $childCreated = $ancestor.CreationDate
                $ancestor = $rows | Where-Object { $_.ProcessId -eq $parentId -and $_.CreationDate -le $childCreated } | Select-Object -First 1
            }
        }
        if ([int]$target.pid -in $protectedIds) { continue }
        $reason = 'changed-process'
        $row = $rows | Where-Object ProcessId -EQ $target.pid | Select-Object -First 1
        if ($null -eq $row -or $row.Name -notmatch '^(cmd|powershell|pwsh)\.exe$' -or $row.CommandLine -cne $target.commandLine) { continue }
        $reason = 'running-child'
        if (@($rows | Where-Object { $_.ParentProcessId -eq $target.pid -and $_.CreationDate -ge $row.CreationDate -and $_.Name -ine 'conhost.exe' }).Count) { continue }
        $reason = 'script-command'
        $arguments = @([regex]::Matches($row.CommandLine, '"[^"]*"|[^\s"]+') | ForEach-Object Value)
        $allowed = if ($row.Name -ieq 'cmd.exe') { '^/(d|q|a|u)$' } else { '^-(NoLogo|NoProfile|NoExit)$' }
        if (!$arguments.Count -or @($arguments | Select-Object -Skip 1 | Where-Object { $_ -notmatch $allowed }).Count) { continue }
        # Require a genuine Microsoft shell, not just an executable named cmd.exe.
        $reason = 'unverified-shell'
        if (!$row.ExecutablePath) { continue }
        $signature = Get-AuthenticodeSignature -LiteralPath $row.ExecutablePath
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|, )O=Microsoft Corporation(,|$)') { continue }
        $reason = 'changed-identity'
        $current = Get-Process -Id $target.pid -ErrorAction Stop
        $handle = $current.Handle
        if ($current.StartTime.ToUniversalTime().ToString('yyyyMMddHHmmssfff') -cne $target.created) { continue }
        $reason = 'no-project-handle'
        if (![DeploymentDirectoryHandles]::HoldsDirectory($handle, $canonicalRoot)) { continue }
        # Check for children once more after signature/handle inspection.
        $reason = 'running-child'
        if (@(Get-CimInstance Win32_Process -Filter "ParentProcessId = $([int]$target.pid)" | Where-Object { $_.CreationDate -ge $row.CreationDate -and $_.Name -ine 'conhost.exe' }).Count) { continue }
        $reason = 'shutdown-denied'
        $current.Kill()
        if (!$current.WaitForExit(2000)) { throw 'Terminal did not exit' }
        $stopped += [int]$target.pid
    } catch {
        # An inaccessible/changed process is skipped, never escalated to a tree
        # kill. Do not emit command lines or native exceptions containing paths.
    } finally {
        if ([int]$target.pid -notin $stopped) { $skipped += @{ pid = [int]$target.pid; reason = $reason } }
        if ($null -ne $current) { $current.Dispose() }
    }
}
ConvertTo-Json -Depth 4 -Compress -InputObject @{ stopped = @($stopped); skipped = @($skipped) }
