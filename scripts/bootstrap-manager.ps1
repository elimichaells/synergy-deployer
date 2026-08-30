param(
    [Parameter(Mandatory=$true)][string]$ManagerDomain,
    [Parameter(Mandatory=$true)][string]$AdminEmail,
    [Parameter(Mandatory=$true)][string]$AdminPassword,
    [Parameter(Mandatory=$true)][string]$DbPassword,
    [string]$AdminName='Admin',
    [string]$ManagerRoot='C:\web\manager',
    [string]$WebRoot='C:\web',
    [string]$DbHost='127.0.0.1',
    [int]$DbPort=5432,
    [string]$DbName='server_manager',
    [string]$DbUser='postgres'
)

$ErrorActionPreference = 'Stop'
Write-Warning 'bootstrap-manager.ps1 is a compatibility entry point. New installations should use install-manager.ps1.'
$configPath = Join-Path $env:TEMP ('manager-legacy-' + [guid]::NewGuid() + '.json')
@{
    ManagerDomain=$ManagerDomain; ManagerRoot=$ManagerRoot; WebRoot=$WebRoot
    AdminName=$AdminName; AdminEmail=$AdminEmail; AdminPassword=$AdminPassword
    DbHost=$DbHost; DbPort=$DbPort; DbName=$DbName
    DbAdminUser=$DbUser; DbAdminPassword=$DbPassword
    InstallPostgreSQL=$false; InstallPgweb=$true
} | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
try {
    & (Join-Path $PSScriptRoot 'install-manager.ps1') -ConfigPath $configPath -Unattended
} finally {
    Remove-Item -LiteralPath $configPath -Force -ErrorAction SilentlyContinue
}
