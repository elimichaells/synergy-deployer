$ErrorActionPreference = 'Stop'
$env:PM2_HOME = Join-Path $env:ProgramData 'Manager\pm2'
$configPath = Join-Path $env:ProgramData 'Manager\pm2-startup.json'
if (Test-Path -LiteralPath $configPath) {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if (-not (Test-Path -LiteralPath $config.node -PathType Leaf) -or
        -not (Test-Path -LiteralPath $config.pm2 -PathType Leaf)) {
        throw 'The saved Node.js or PM2 executable is missing. Repair the PM2 startup configuration.'
    }
    $env:Path = (Split-Path -Parent $config.node) + ';' + (Split-Path -Parent $config.pm2) + ';' + $config.path
    if ($config.caddyDataHome) { $env:XDG_DATA_HOME = $config.caddyDataHome }
    if ($config.caddyConfigHome) { $env:XDG_CONFIG_HOME = $config.caddyConfigHome }
    $pm2 = $config.pm2
} else {
    # Compatibility with installations made before startup paths were recorded.
    $pm2 = (Get-Command pm2.cmd -ErrorAction Stop).Source
}
& $pm2 resurrect
if ($LASTEXITCODE -ne 0) { throw ('PM2 boot recovery failed with exit code ' + $LASTEXITCODE) }
