param([Parameter(Mandatory=$true)][string]$PlanFile)
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
$env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+$env:PSModulePath
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
$plan=Get-Content -LiteralPath $PlanFile -Raw | ConvertFrom-Json
$stage=Split-Path -Parent $PlanFile
$receipt=Join-Path $stage 'result.json'
$utf8=New-Object Text.UTF8Encoding($false)
function Write-Json($file,$value){[IO.File]::WriteAllText($file,($value|ConvertTo-Json -Depth 12 -Compress),$utf8)}
function Write-ToolPaths([string]$text){
  $temporary=Join-Path $plan.agentRoot ('tool-paths-'+[Guid]::NewGuid().ToString()+'.tmp')
  try{[IO.File]::WriteAllText($temporary,$text,$utf8);Move-Item -LiteralPath $temporary -Destination $pathsFile -Force}finally{Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue}
}
function Quote-PS([string]$s){return "'"+$s.Replace("'","''")+"'"}
function Run($file,[string[]]$arguments){ & $file @arguments; if($LASTEXITCODE -ne 0){throw ('Command failed: '+[IO.Path]::GetFileName($file)+' (exit '+$LASTEXITCODE+')')} }
function Private-Folder($folder){New-Item -ItemType Directory -Path $folder -Force|Out-Null;Run 'icacls.exe' @($folder,'/inheritance:r','/grant:r','*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F')}
function Fetch-Verified($asset,$file){
  if($asset.url -notmatch '^https://' -or $asset.sha256 -notmatch '^[a-f0-9]{64}$'){throw 'Invalid verified asset'}
  Invoke-WebRequest -UseBasicParsing -Uri $asset.url -OutFile $file
  if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $asset.sha256){throw 'Downloaded installer checksum did not match'}
}
function Extract-Database($zip,$destination,[switch]$All){
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Directory]::CreateDirectory($destination)|Out-Null
  $prefix=[IO.Path]::GetFullPath($destination).TrimEnd('\')+'\'
  $archive=[IO.Compression.ZipFile]::OpenRead($zip)
  try{foreach($entry in $archive.Entries){
    # Server binaries, shared libraries and initialization resources only.
    # The EDB archive also contains pgAdmin/StackBuilder trees with long paths.
    if(-not $All -and $entry.FullName -notmatch '^[^/]+/(bin|lib|share)/'){continue}
    $file=[IO.Path]::GetFullPath((Join-Path $destination $entry.FullName))
    if(-not $file.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Archive entry escapes the service directory'}
    if($file.Length -gt 240){$file='\\?\'+$file}
    if($entry.FullName.EndsWith('/')){[IO.Directory]::CreateDirectory($file)|Out-Null;continue}
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file))|Out-Null
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$file,$false)
  }}finally{$archive.Dispose()}
}
function Agent-Check($script){
  $name='ManagerToolCheck-'+[Guid]::NewGuid().ToString();$check=Join-Path $plan.agentRoot $name;New-Item -ItemType Directory -Path $check|Out-Null;$file=Join-Path $check 'account-check.ps1';$done=Join-Path $check 'account-check.json'
  [IO.File]::WriteAllText($file,('$ErrorActionPreference="Stop"; try { '+$script+'; [IO.File]::WriteAllText('+(Quote-PS $done)+',"ok") } catch { [IO.File]::WriteAllText('+(Quote-PS $done)+',"failed: "+$_.Exception.Message); exit 1 }'),$utf8)
  # Only the dedicated check directory is shared with the service account.
  Run 'icacls.exe' @($stage,'/grant','*S-1-5-19:RX'); if(Test-Path -LiteralPath (Join-Path $stage 'init-password')){Run 'icacls.exe' @((Join-Path $stage 'init-password'),'/grant','*S-1-5-19:R')}
  try{
    $a=New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$file+'"')
    Register-ScheduledTask -TaskName $name -Action $a -Principal (New-ScheduledTaskPrincipal -UserId 'S-1-5-19' -LogonType ServiceAccount -RunLevel Limited)|Out-Null
    Start-ScheduledTask -TaskName $name
    $complete=$false;for($i=0;$i -lt 120;$i++){Start-Sleep -Seconds 1;if(Test-Path -LiteralPath $done){$complete=$true;break}}
    if(-not $complete){throw 'The agent account check timed out. Existing paths were restored.'};$detail=Get-Content -LiteralPath $done -Raw;if($detail -ne 'ok'){throw ('Agent account check '+$detail)}
  }finally{if((Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue).State -eq 'Running'){Stop-ScheduledTask -TaskName $name};Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue;Run 'icacls.exe' @($stage,'/remove:g','*S-1-5-19');Remove-Item -LiteralPath $file,$done -Force -ErrorAction SilentlyContinue}
}
$savedPaths=$null;$pathsFile=Join-Path $plan.agentRoot 'tool-paths.json';$createdService=$null
try{
  $principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'An elevated administrator SSH login is required'}
  $agent=Get-Content -LiteralPath (Join-Path $plan.agentRoot 'agent.json') -Raw | ConvertFrom-Json
  if($agent.serverId -ne $plan.serverId -or -not $agent.enrolled){throw 'This agent directory belongs to another server'}
  Write-Json $receipt @{status='running';service=$plan.service;operationId=$plan.operationId;pid=$PID;processStartedAt=(Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o')}
  $savedPaths=Get-Content -LiteralPath $pathsFile -Raw;$paths=@{};($savedPaths|ConvertFrom-Json).PSObject.Properties|ForEach-Object{$paths[$_.Name]=$_.Value}
  [IO.File]::WriteAllText((Join-Path $stage 'previous-paths.json'),$savedPaths,$utf8)
  $tool=@{postgresql='psql';mysql='mysql';mariadb='mariadb';angular='ng';mongodb='mongod';sqlserver='sqlcmd'}[$plan.service];if(-not $tool){$tool=$plan.service}
  $result=@{status='success';operationId=$plan.operationId;service=$plan.service;mode=$plan.mode;port=$plan.port;host='127.0.0.1';managed=($plan.mode -eq 'install')}
  if($plan.service -eq 'phpmyadmin'){
    if($plan.mode -ne 'install'){throw 'The private browser requires its own installation'}
    $target=Join-Path $plan.dataRoot 'phpmyadmin';$marker=Join-Path $plan.agentRoot 'database-browser.json'
    if((Test-Path -LiteralPath $target) -or (Test-Path -LiteralPath $marker)){throw 'The browser destination already exists. It will not be overwritten.'}
    Private-Folder $target
    $vc=Join-Path $target 'vcredist.exe';Fetch-Verified $plan.downloads.vcredist $vc
    $setup=Start-Process -FilePath $vc -ArgumentList @('/install','/quiet','/norestart') -Wait -PassThru -WindowStyle Hidden
    if($setup.ExitCode -notin @(0,3010,1638)){throw 'Visual C++ prerequisite failed'}
    Run $paths.node @((Join-Path $stage 'install-database-browser.cjs'),$PlanFile,$target)
    Copy-Item -LiteralPath (Join-Path $stage 'database-browser-agent.cjs') -Destination (Join-Path $target 'browser-check.cjs')
    Run 'icacls.exe' @($target,'/grant','*S-1-5-19:(OI)(CI)RX')
    foreach($folder in @('temp','sessions')){Run 'icacls.exe' @((Join-Path $target $folder),'/grant','*S-1-5-19:(OI)(CI)M')}
    # Verify access using the actual service account before publishing its marker.
    $checkCode='require(process.argv[1]).handle(process.argv[2],"https://manager.invalid",{publicBase:"https://manager.invalid/api/database-browser/"+"a".repeat(43)+"/",method:"GET",path:"index.php",body:"",connection:{host:"127.0.0.1",port:1}}).then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))'
    Agent-Check ('& '+(Quote-PS $paths.node)+' -e '+(Quote-PS $checkCode)+' '+(Quote-PS (Join-Path $target 'browser-check.cjs'))+' '+(Quote-PS $target)+';if($LASTEXITCODE -ne 0){throw "Browser service account check failed"}')
    Copy-Item -LiteralPath (Join-Path $target 'database-browser.json') -Destination $marker
    $result.path=$target;$result.version=$plan.downloads.phpmyadmin.version;Write-Json $receipt $result
    Write-Output '[service] Private phpMyAdmin ready through the agent. Existing web sites and PHP defaults are preserved.'
    return
  }
  if($plan.mode -eq 'install-version'){
    if($plan.service -notin @('node','go','php') -or $plan.version -notmatch '^\d+\.\d+\.\d+$'){throw 'Invalid runtime version'}
    $target=Join-Path $plan.dataRoot ('versions\'+$plan.service+'\'+$plan.version)
    if(Test-Path -LiteralPath $target){throw 'This version directory already exists. It will not be replaced.'}
    Private-Folder $target;Run 'icacls.exe' @($target,'/grant','*S-1-5-19:(OI)(CI)RX')
    $archive=Join-Path $target 'package.zip';Fetch-Verified $plan.downloads.versionAsset $archive
    Extract-Database $archive $target -All
    $versionExe=Join-Path $target $plan.downloads.versionAsset.executable
    if($plan.service -eq 'php'){
      $ini=Get-Content -LiteralPath (Join-Path $target 'php.ini-production') -Raw
      $ini=$ini -replace '(?m)^[ \t]*;?[ \t]*extension_dir[ \t]*=.*$',''
      $ini+="`nextension_dir="+('"'+(Join-Path $target 'ext').Replace('\','/')+'"')+"`n"
      foreach($extension in @('bcmath','curl','fileinfo','gd','gmp','intl','mbstring','mysqli','openssl','pdo_mysql','pdo_pgsql','sodium','zip')){
        if(Test-Path -LiteralPath (Join-Path $target ('ext\php_'+$extension+'.dll'))){$ini=$ini -replace ('(?m)^[ \t]*;?[ \t]*extension[ \t]*=[ \t]*'+[regex]::Escape($extension)+'[ \t]*$'),' ';$ini+="`nextension="+$extension+"`n"}
      }
      [IO.File]::WriteAllText((Join-Path $target 'php.ini'),$ini,$utf8)
      [IO.Directory]::CreateDirectory((Join-Path $target 'conf.d'))|Out-Null
    }
    $arg=if($plan.service -eq 'go'){'version'}else{'--version'}
    Agent-Check ('$v=(& '+(Quote-PS $versionExe)+' '+$arg+'|Out-String);if($LASTEXITCODE -ne 0 -or $v -notmatch '+(Quote-PS ([regex]::Escape($plan.version)))+'){throw "Installed runtime version check failed"}')
    $registryFile=Join-Path $plan.agentRoot 'runtime-versions.json';$registry=@{}
    if(Test-Path -LiteralPath $registryFile){(Get-Content -LiteralPath $registryFile -Raw|ConvertFrom-Json).PSObject.Properties|ForEach-Object{$versions=@{};$_.Value.PSObject.Properties|ForEach-Object{$versions[$_.Name]=$_.Value};$registry[$_.Name]=$versions}}
    if(-not $registry.ContainsKey($plan.service)){$registry[$plan.service]=@{}};$registry[$plan.service][$plan.version]=$versionExe
    $temporary=Join-Path $plan.agentRoot ('runtime-versions-'+[Guid]::NewGuid().ToString()+'.tmp');Write-Json $temporary $registry;Move-Item -LiteralPath $temporary -Destination $registryFile -Force
    Remove-Item -LiteralPath $archive -Force
    $result.version=$plan.version;$result.path=$versionExe;$result.managed=$true;Write-Json $receipt $result
    Write-Output '[service] Project runtime installed and verified. The server default and existing applications are unchanged.'
    return
  }
  if($plan.mode -eq 'reuse'){
    if(-not(Test-Path -LiteralPath $plan.path -PathType Leaf)){throw 'Selected executable is missing'}
    $paths[$tool]=$plan.path
  }else{
    $match=@{postgresql='postgres';mysql='mysql|maria';mariadb='mysql|maria';caddy='caddy';mongodb='mongo';sqlserver='mssql|sqlservr'}[$plan.service]
    if($match -and @(Get-CimInstance Win32_Service|Where-Object{($_.Name+' '+$_.PathName) -match $match}).Count){throw 'An existing service was found. Reuse it instead of installing another instance.'}
    if($plan.port -and (Get-NetTCPConnection -LocalPort $plan.port -State Listen -ErrorAction SilentlyContinue)){throw 'The selected port is already in use'}
    if($plan.service -eq 'caddy' -and (Get-NetTCPConnection -LocalPort 80,443,2019,2029 -State Listen -ErrorAction SilentlyContinue)){throw 'An existing web service occupies the proxy ports'}
    $target=[IO.Path]::GetFullPath((Join-Path $plan.dataRoot $plan.service))
    if(Test-Path -LiteralPath $target){throw 'The service destination already exists. It will not be initialized or overwritten.'}
    Private-Folder $target
    Run 'icacls.exe' @($target,'/grant','*S-1-5-19:(OI)(CI)RX')
    if($plan.service -eq 'sqlserver'){
      . (Join-Path $stage 'install-remote-sqlserver.ps1')
      $createdService='MSSQL$MANAGER'
      $sqlResult=Install-RemoteSqlServer $plan $target $stage $paths.node $PlanFile
      $paths.sqlcmd=$sqlResult.path;$result.username=$sqlResult.username;$result.serviceName=$sqlResult.serviceName;$result.dataPath=$sqlResult.dataPath
    }elseif($plan.service -eq 'mongodb'){
      foreach($existing in @('C:\data\db',(Join-Path $env:ProgramData 'MongoDB'))){if((Test-Path -LiteralPath $existing -PathType Container) -and @(Get-ChildItem -LiteralPath $existing -Force).Count){throw 'Existing MongoDB data was found. Reuse it instead of creating another installation.'}}
      $vc=Join-Path $target 'vcredist.exe';Fetch-Verified $plan.downloads.vcredist $vc
      $setup=Start-Process -FilePath $vc -ArgumentList @('/install','/quiet','/norestart') -Wait -PassThru -WindowStyle Hidden
      if($setup.ExitCode -notin @(0,3010,1638)){throw 'Visual C++ prerequisite failed'}
      $zip=Join-Path $target 'package.zip';Fetch-Verified $plan.downloads.mongodb $zip
      $binaries=Join-Path $target 'binaries';Extract-Database $zip $binaries -All
      $bins=@(Get-ChildItem -LiteralPath $binaries -Directory | ForEach-Object {Join-Path $_.FullName 'bin\mongod.exe'} | Where-Object {Test-Path -LiteralPath $_ -PathType Leaf})
      if($bins.Count -ne 1){throw 'Unexpected MongoDB archive layout'};$paths.mongod=$bins[0]
      Run $paths.mongod @('--version')
      $data=Join-Path $target 'data';$logs=Join-Path $target 'logs';$config=Join-Path $target 'mongod.json'
      foreach($directory in @($data,$logs)){New-Item -ItemType Directory -Path $directory|Out-Null;Run 'icacls.exe' @($directory,'/grant','*S-1-5-19:(OI)(CI)M')}
      Write-Json $config @{storage=@{dbPath=$data};systemLog=@{destination='file';path=(Join-Path $logs 'mongodb.log');logAppend=$true};net=@{bindIp='127.0.0.1';port=$plan.port};security=@{authorization='enabled'}}
      $createdService='ManagerMongoDB';Run $paths.mongod @('--config',$config,'--install','--serviceName',$createdService,'--serviceDisplayName','Manager MongoDB')
      Run 'sc.exe' @('config',$createdService,'obj=','NT AUTHORITY\LocalService','start=','auto');Start-Service -Name $createdService
      Run $paths.node @((Join-Path $stage 'initialize-remote-database.cjs'),$PlanFile,'initialize')
      Restart-Service -Name $createdService
      Run $paths.node @((Join-Path $stage 'initialize-remote-database.cjs'),$PlanFile,'verify')
      $result.serviceName=$createdService;$result.dataPath=$data;$result.configPath=$config;$result.username='manager_provisioner';$result.password=$plan.databasePassword
      Remove-Item -LiteralPath $zip,$vc -Force
    }elseif($plan.downloads.archive){
      $zip=Join-Path $target 'package.zip';Fetch-Verified $plan.downloads.archive $zip
      $binaries=Join-Path $target 'binaries';Extract-Database $zip $binaries
      $bins=@(Get-ChildItem -LiteralPath $binaries -Directory | ForEach-Object {Join-Path $_.FullName 'bin'} | Where-Object {Test-Path -LiteralPath $_ -PathType Container})
      if($bins.Count -ne 1){throw 'Unexpected database archive layout'};$bin=$bins[0];$data=Join-Path $target 'data';$config=Join-Path $target 'my.ini'
      $result.dataPath=$data;$result.configPath=$config; New-Item -ItemType Directory -Path $data|Out-Null; Run 'icacls.exe' @($data,'/grant','*S-1-5-19:(OI)(CI)M')
      if($plan.service -eq 'postgresql'){
        $pw=Join-Path $stage 'init-password';[IO.File]::WriteAllText($pw,$plan.databasePassword,$utf8)
        try{Agent-Check ('& '+(Quote-PS (Join-Path $bin 'initdb.exe'))+' -D '+(Quote-PS $data)+' -U manager_provisioner -A scram-sha-256 --encoding=UTF8 --pwfile='+(Quote-PS $pw)+'; if($LASTEXITCODE -ne 0){throw "Database initialization failed"}') }finally{Remove-Item -LiteralPath $pw -Force -ErrorAction SilentlyContinue}
        $config=Join-Path $data 'postgresql.conf';[IO.File]::AppendAllText($config,"`nlisten_addresses='127.0.0.1'`nport="+$plan.port+"`npassword_encryption='scram-sha-256'`n",$utf8)
        $result.configPath=$config;$result.username='manager_provisioner';$createdService='ManagerPostgreSQL'
        Run (Join-Path $bin 'pg_ctl.exe') @('register','-N',$createdService,'-D',$data,'-S','auto','-U','NT AUTHORITY\LocalService')
        $paths.psql=Join-Path $bin 'psql.exe'
      }else{
        $mysqld=Join-Path $bin 'mysqld.exe';if(Test-Path -LiteralPath (Join-Path $bin 'mariadbd.exe')){$mysqld=Join-Path $bin 'mariadbd.exe'}
        $init=Join-Path $stage 'secure-init.sql';[IO.File]::WriteAllText($init,"ALTER USER 'root'@'localhost' IDENTIFIED BY '"+$plan.databasePassword+"';",$utf8)
        $text="[mysqld]`nbasedir="+(Split-Path $bin -Parent).Replace('\','/')+"`ndatadir="+$data.Replace('\','/')+"`nport="+$plan.port+"`nbind-address=127.0.0.1`n"
        if($plan.service -eq 'mysql'){$text+="mysqlx=OFF`n"}
        [IO.File]::WriteAllText($config,$text,$utf8)
        try{
          if($plan.service -eq 'mysql'){Run $mysqld @("--defaults-file=$config",'--initialize-insecure',"--init-file=$init")}
          else{Run (Join-Path $bin 'mariadb-install-db.exe') @("--datadir=$data",'--skip-networking');[IO.File]::AppendAllText($config,'init-file='+$init.Replace('\','/')+"`n",$utf8)}
          $createdService=if($plan.service -eq 'mysql'){'ManagerMySQL'}else{'ManagerMariaDB'}
          Run $mysqld @('--install',$createdService,"--defaults-file=$config")
          Run 'sc.exe' @('config',$createdService,'obj=','NT AUTHORITY\LocalService','start=','auto')
          Run 'icacls.exe' @($stage,'/grant','*S-1-5-19:RX'); Run 'icacls.exe' @($init,'/grant','*S-1-5-19:R')
          Start-Service -Name $createdService
          $option=Join-Path $stage 'client.cnf';[IO.File]::WriteAllText($option,"[client]`nuser=root`npassword="+$plan.databasePassword+"`nhost=127.0.0.1`nport="+$plan.port+"`n",$utf8)
          $client=Join-Path $bin 'mysql.exe';if($plan.service -eq 'mariadb'){$client=Join-Path $bin 'mariadb.exe'}
          $ready=$false;for($i=0;$i -lt 60;$i++){& $client "--defaults-extra-file=$option" '--connect-timeout=2' '-e' 'SELECT 1' 2>$null|Out-Null;if($LASTEXITCODE -eq 0){$ready=$true;break};Start-Sleep -Seconds 1};if(-not $ready){throw 'Database did not pass authenticated readiness'}
          $paths[$tool]=$client
        }finally{[IO.File]::WriteAllText($config,$text,$utf8);Remove-Item -LiteralPath $init,(Join-Path $stage 'client.cnf') -Force -ErrorAction SilentlyContinue;Run 'icacls.exe' @($stage,'/remove:g','*S-1-5-19')}
        $result.username='root'
      }
      if($plan.service -eq 'postgresql'){
        Start-Service -Name $createdService;$old=$env:PGPASSWORD;$env:PGPASSWORD=$plan.databasePassword
        try{Run $paths.psql @('-X','-h','127.0.0.1','-p',[string]$plan.port,'-U','manager_provisioner','-d','postgres','-v','ON_ERROR_STOP=1','-c','SELECT 1')}finally{$env:PGPASSWORD=$old}
      }
      $result.serviceName=$createdService;$result.password=$plan.databasePassword
      Remove-Item -LiteralPath $zip -Force
    }elseif($plan.service -in @('sling','angular')){
      Run $paths.node @((Join-Path $stage 'install-remote-tool.cjs'),$PlanFile,$target)
      $paths[$tool]=if($plan.service -eq 'sling'){Join-Path $target 'sling.exe'}else{Join-Path $target 'node_modules\.bin\ng.cmd'}
    }elseif($plan.service -in @('node','git','caddy')){
      $zip=Join-Path $target 'package.zip';Fetch-Verified $plan.downloads.($plan.service) $zip;Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $target 'binaries')
      if($plan.service -eq 'node'){$paths.node=(Get-ChildItem (Join-Path $target 'binaries\node-*\node.exe')|Select-Object -First 1).FullName}else{$paths[$tool]=Join-Path $target $(if($plan.service -eq 'git'){'binaries\cmd\git.exe'}else{'binaries\caddy.exe'})}
      Remove-Item -LiteralPath $zip -Force
    }elseif($plan.service -eq 'pm2'){
      Run 'icacls.exe' @($target,'/grant','*S-1-5-19:(OI)(CI)M'); Agent-Check ('& '+(Quote-PS $paths.node)+' '+(Quote-PS (Join-Path (Split-Path $paths.node -Parent) 'node_modules\npm\bin\npm-cli.js'))+' install --prefix '+(Quote-PS $target)+' --omit=dev --ignore-scripts --no-audit --no-fund '+(Quote-PS ('pm2@'+$plan.downloads.pm2Version))+'; if($LASTEXITCODE -ne 0){throw "PM2 installation failed"}');$paths.pm2=Join-Path $target 'node_modules\pm2\bin\pm2'
    }else{
      $packages=@{go='golang';php='php';python='python';composer='composer'};if(-not $packages.ContainsKey($plan.service)){throw 'Unsupported runtime'}
      $choco=Get-Command choco.exe -ErrorAction SilentlyContinue
      if(-not $choco){$bootstrap=Join-Path $stage 'chocolatey.ps1';Fetch-Verified $plan.downloads.chocolatey $bootstrap; & $bootstrap; $choco=Get-Command "$env:ProgramData\chocolatey\bin\choco.exe"}
      & $choco.Source install $packages[$plan.service] --yes --no-progress --limit-output --use-package-exit-codes
      if($LASTEXITCODE -notin @(0,3010,1641)){throw 'Runtime package installation failed'}
      $env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+$env:Path
      $command=if($plan.service -eq 'python'){'python.exe'}elseif($plan.service -eq 'composer'){'composer.bat'}else{$plan.service+'.exe'}
      $found=Get-Command $command -ErrorAction SilentlyContinue|Select-Object -First 1
      if(-not $found){throw 'Installed executable could not be located. Inspect custom paths.'}
      $paths[$tool]=$found.Source
    }
  }
  if($plan.service -eq 'postgresql'){foreach($name in @('pg_dump','pg_restore')){$paths[$name]=Join-Path (Split-Path $paths.psql -Parent) ($name+'.exe')}}
  Write-ToolPaths ($paths|ConvertTo-Json -Compress)
  Agent-Check ('& '+(Quote-PS $paths.node)+' '+(Quote-PS (Join-Path $plan.agentRoot 'manager-agent.cjs'))+' check-tools --root '+(Quote-PS $plan.agentRoot)+'; if($LASTEXITCODE -ne 0){throw "Tool validation failed"}')
  $result.path=$paths[$tool];Write-Json $receipt $result
  Write-Output '[service] Configuration complete; authenticated checks passed where a database was installed.'
}catch{
  if($savedPaths){Write-ToolPaths $savedPaths}
  # Never remove initialized data or an existing installation during recovery.
  if($createdService -and $target){
    $registered=Get-CimInstance Win32_Service -Filter ("Name='"+$createdService+"'") -ErrorAction SilentlyContinue
    $ownedExecutable='';if($registered.PathName -match '^\s*"([^"]+)"'){$ownedExecutable=$Matches[1]}elseif($registered.PathName -match '^\s*(.+?\.exe)(?:\s|$)'){$ownedExecutable=$Matches[1]}
    if($ownedExecutable -and [IO.Path]::GetFullPath($ownedExecutable).StartsWith([IO.Path]::GetFullPath($target).TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){Stop-Service -Name $createdService -ErrorAction SilentlyContinue}
  }
  $message=$_.Exception.Message+"`n"+$_.ScriptStackTrace; if($plan.databasePassword){$message=$message.Replace([string]$plan.databasePassword,'[redacted]')}
  Write-Json $receipt @{status='failed';operationId=$plan.operationId;service=$plan.service;serviceName=$createdService;message=$message;preservedData=$true}
  Write-Error $message
  exit 1
}
