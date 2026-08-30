[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'manager-install.json'),
    [switch]$Unattended,
    [switch]$Plan
)

$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot 'scripts\install-manager.ps1'
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'The Manager installer is missing from this package' }
if ($ConfigPath -and -not [IO.Path]::IsPathRooted($ConfigPath)) {
    $relativeConfig = $ConfigPath -replace '^[.][\\/]', ''
    $ConfigPath = Join-Path $PSScriptRoot $relativeConfig
}
if ($ConfigPath) { $ConfigPath = [IO.Path]::GetFullPath($ConfigPath) }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $PSCommandPath + '"'))
    if ($ConfigPath) { $arguments += @('-ConfigPath',('"' + $ConfigPath + '"')) }
    if ($Unattended) { $arguments += '-Unattended' }
    if ($Plan) { $arguments += '-Plan' }
    $process = Start-Process powershell.exe -Verb RunAs -ArgumentList ($arguments -join ' ') -Wait -PassThru
    exit $process.ExitCode
}

$invoke = @{}
if ($ConfigPath -and (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { $invoke.ConfigPath = $ConfigPath }
elseif ($Unattended) { throw ('Config file not found: ' + $ConfigPath) }
if ($Unattended) { $invoke.Unattended = $true }
if ($Plan) { $invoke.Plan = $true }
& $installer @invoke
if (-not $?) { exit 1 }
exit 0
