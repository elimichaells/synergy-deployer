$ErrorActionPreference = 'Stop'
$env:PM2_HOME = Join-Path $env:ProgramData 'Manager\pm2'
$pm2 = (Get-Command pm2.cmd -ErrorAction Stop).Source
& $pm2 resurrect
