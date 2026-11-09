$ErrorActionPreference = 'Stop'
$env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+$env:PSModulePath
$paths = '__MANAGER_PATHS__' | ConvertFrom-Json
$ids = @('node','git','caddy','pm2','psql','pg_dump','pg_restore','mysql','mariadb','go','php','python','composer','sling','ng','mongod','sqlcmd','redis')
$tools = @{}
$serviceRows = @()
$processes = @(Get-Process node,caddy,php,python,python3 -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object ProcessName,Path -Unique)
$services = @(Get-CimInstance Win32_Service | Where-Object { $_.Name -match 'postgres|mysql|maria|caddy|mongo|redis|memurai|mssql' -or $_.DisplayName -match 'postgres|mysql|maria|caddy|mongo|redis|memurai|mssql' })
foreach ($s in $services) {
  $exe = ''; $config = ''
  if ($s.PathName -match '^\s*"([^"]+)"') { $exe = $Matches[1] } elseif ($s.PathName -match '^\s*(.+?\.exe)(?:\s|$)') { $exe = $Matches[1] }
  # Windows permits quoting the entire --option=value token, including spaces.
  $arguments = @([regex]::Matches($s.PathName,'(?:[^\s"]+|"[^"]*")+') | ForEach-Object { $_.Value.Replace('"','') })
  for ($i=1; $i -lt $arguments.Count; $i++) {
    if ($arguments[$i] -match '^--(?:config|defaults-file)=(.+)$') { $config=$Matches[1]; break }
    if ($arguments[$i] -in @('--config','--defaults-file','-D') -and $i+1 -lt $arguments.Count) { $config=$arguments[$i+1]; break }
  }
  $serviceRows += @{name=$s.Name;status=[string]$s.State;executable=$exe;config=[string]$config}
}
foreach ($id in $ids) {
  $candidates = @()
  if ($paths.$id) { $candidates += [string]$paths.$id }
  $command = Get-Command $(if($id -eq 'composer'){'composer.bat'}elseif($id -eq 'ng'){'ng.cmd'}elseif($id -eq 'redis'){'memurai-cli.exe'}else{$id + '.exe'}) -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { $candidates += $command.Source }
  $processNames = if ($id -eq 'python') { @('python','python3') } else { @($id) }
  $candidates += @($processes | Where-Object { $_.ProcessName -in $processNames } | ForEach-Object { $_.Path })
  $patterns = switch ($id) {
    'node' { @("$env:ProgramFiles\nodejs\node.exe") }
    'git' { @("$env:ProgramFiles\Git\cmd\git.exe", "$env:ProgramFiles\Git\bin\git.exe") }
    'pm2' { @("$env:APPDATA\npm\node_modules\pm2\bin\pm2", "$env:ProgramData\npm\node_modules\pm2\bin\pm2") }
    'caddy' { @('C:\Caddy\caddy.exe','C:\web\caddy.exe',"$env:ProgramData\chocolatey\bin\caddy.exe") }
    { $_ -in @('psql','pg_dump','pg_restore') } { @("$env:ProgramFiles\PostgreSQL\*\bin\$id.exe") }
    { $_ -in @('mysql','mariadb') } { @("$env:ProgramFiles\MySQL\*\bin\$id.exe", "$env:ProgramFiles\MariaDB*\bin\$id.exe", "C:\tools\mysql\current\bin\$id.exe") }
    'mongod' { @("$env:ProgramFiles\MongoDB\Server\*\bin\mongod.exe") }
    'redis' { @("$env:ProgramFiles\Memurai\memurai-cli.exe","$env:ProgramFiles\Redis\redis-cli.exe") }
    'sqlcmd' { @("$env:ProgramFiles\Microsoft SQL Server\Client SDK\ODBC\*\Tools\Binn\SQLCMD.EXE","$env:ProgramFiles\sqlcmd\sqlcmd.exe") }
    'go' { @("$env:ProgramFiles\Go\bin\go.exe") }
    'php' { @('C:\tools\php*\php.exe','C:\php\php.exe') }
    'python' { @("$env:LOCALAPPDATA\Programs\Python\Python*\python.exe", "$env:ProgramFiles\Python*\python.exe") }
    default { @() }
  }
  foreach ($pattern in $patterns) { $candidates += @(Get-Item -Path $pattern -ErrorAction SilentlyContinue | Where-Object { -not $_.PSIsContainer } | ForEach-Object { $_.FullName }) }
  foreach ($s in $serviceRows) {
    if ($s.executable -and ($id -eq 'caddy' -or $id -in @('psql','pg_dump','pg_restore','mysql','mariadb','mongod'))) {
      $candidate = Join-Path (Split-Path -Parent $s.executable) ($id + '.exe')
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { $candidates += $candidate }
    }
  }
  $rows = @()
  foreach ($exe in @($candidates | Select-Object -Unique | Select-Object -First 8)) {
    $version = ''; $problem = ''
    try {
      if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'File not found' }
      if ($id -eq 'pm2') {
        $metadata = Get-Content -LiteralPath (Join-Path (Split-Path (Split-Path $exe -Parent) -Parent) 'package.json') -Raw | ConvertFrom-Json
        if ($metadata.name -ne 'pm2') { throw 'Not a PM2 package' }
        $version = [string]$metadata.version
      } else {
        $arg = if($id -eq 'sqlcmd'){'-?'}elseif ($id -in @('go','caddy','ng')) { 'version' } else { '--version' }
        $info = New-Object Diagnostics.ProcessStartInfo
        $info.EnvironmentVariables['FORCE_COLOR']='0';$info.EnvironmentVariables['NO_COLOR']='1';$info.EnvironmentVariables['NG_CLI_ANALYTICS']='false'
        $info.FileName = $exe; $info.Arguments = $arg; if($id -in @('composer','ng') -and $exe -match '\.(bat|cmd)$'){$info.FileName=$env:ComSpec; $info.Arguments='/d /s /c ""'+$exe+'" '+$arg+'"'}; $info.UseShellExecute = $false; $info.CreateNoWindow = $true
        $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
        $proc = New-Object Diagnostics.Process; $proc.StartInfo = $info
        try {
          $null = $proc.Start(); $stdout = $proc.StandardOutput.ReadToEndAsync(); $stderr = $proc.StandardError.ReadToEndAsync()
          if (-not $proc.WaitForExit(5000)) { $proc.Kill(); throw 'Version check timed out' }
          if ($proc.ExitCode -ne 0) { throw 'Version check failed' }
          $version = (($stdout.Result + $stderr.Result) -split '[\r\n]+' | Where-Object { $_ } | Select-Object -First 1)
          if($id -eq 'sqlcmd'){$match=[regex]::Match(($stdout.Result+$stderr.Result),'(?i)Version[: ]+v?(\d+\.\d+(?:\.\d+)*)');if(-not $match.Success -or ($stdout.Result+$stderr.Result) -notmatch 'sqlcmd|SQL Server Command Line Tool'){throw 'SQL Server client version check failed'};$version='sqlcmd version '+$match.Groups[1].Value}
          if($id -eq 'ng'){$match=[regex]::Match(($stdout.Result+$stderr.Result),'Angular CLI\s*:\s*\d+\.\d+\.\d+');if(-not $match.Success){throw 'Angular CLI version check failed'};$version=$match.Value -replace '\s*:\s*',': '}
        } finally { $proc.Dispose() }
      }
    } catch { $problem = 'File missing, inaccessible, or version check failed' }
    $rows += @{path=$exe;version=([string]$version).Substring(0,[Math]::Min(200,([string]$version).Length));error=$problem}
  }
  $tools[$id] = @($rows)
}
$portsKnown = $true; $ports = @()
try { $ports = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Select-Object -ExpandProperty LocalPort -Unique) } catch { $portsKnown = $false }
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'AMD64') { 'x64' } else { $env:PROCESSOR_ARCHITECTURE }
Write-Output ('MANAGER_INVENTORY=' + (@{platform='win32';arch=$arch;privileged=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);portsKnown=$portsKnown;ports=@($ports);services=@($serviceRows);tools=$tools} | ConvertTo-Json -Depth 6 -Compress))
