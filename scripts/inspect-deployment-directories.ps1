$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -Path (Join-Path $PSScriptRoot 'DeploymentDirectoryHandles.cs')
$canonicalRoot = [DeploymentDirectoryHandles]::ResolveRoot([string]$request.root)
$owners = @()
$unavailable = 0
foreach ($row in @(Get-CimInstance Win32_Process)) {
    $current = $null
    try {
        $current = Get-Process -Id $row.ProcessId -ErrorAction Stop
        $handle = $current.Handle
        if ($current.StartTime.ToUniversalTime().ToString('yyyyMMddHHmmssfff') -cne $row.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssfff')) { continue }
        if ([DeploymentDirectoryHandles]::HoldsDirectory($handle, $canonicalRoot)) {
            $owners += @{ pid = [int]$row.ProcessId; name = [string]$row.Name }
        }
    } catch { $unavailable++ }
    finally { if ($null -ne $current) { $current.Dispose() } }
}
# Report only process identities, never command lines, file names, or contents.
ConvertTo-Json -Depth 4 -Compress -InputObject @{ owners = @($owners | Select-Object -First 50); truncated = $owners.Count -gt 50; unavailable = $unavailable }
