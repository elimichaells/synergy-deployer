const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const q=s=>"'"+s.replaceAll("'","''")+"'";
test('online setup distinguishes client tools, server binaries, a running server and explicit reuse',{skip:process.platform!=='win32'},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'manager-installer-tools-'));
  try{
    const script=`
      $ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
      $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(${q(path.resolve(__dirname,'../scripts/install-manager.ps1'))},[ref]$tokens,[ref]$errors)
      foreach($name in @('Find-PostgresTool','Ensure-OnlinePostgres')){Invoke-Expression ($ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true).Extent.Text)}
      $bin=${q(root)};$env:PG_BIN_PATH=$null;$env:ProgramData=$bin
      $postgresPackage='postgresql18';$dbPort=25499;$dbAdminUser='fixture';$dbAdminPassword='fixture-only'
      function Get-Command {param($Name,$ErrorAction) if($Name -eq 'psql.exe'){[pscustomobject]@{Source=(Join-Path $bin 'psql.exe')}}}
      function Get-ChildItem {param($Path,[switch]$Directory,$ErrorAction) @()}
      function Get-NetTCPConnection {param($State,$LocalPort,$ErrorAction) if($script:listening){[pscustomobject]@{LocalPort=$LocalPort}}}
      function Initialize-ManagerOfflineControlPostgres {param($Bin,$Data,$Port,$User,$Password) $script:initialized++}
      function Invoke-Native {param($File,$Arguments,$Label) $script:installed++;foreach($name in @('postgres','initdb','pg_ctl','pg_isready')){[IO.File]::WriteAllText((Join-Path $bin ($name+'.exe')),'fixture')}}
      foreach($name in @('psql','pg_dump','pg_restore')){[IO.File]::WriteAllText((Join-Path $bin ($name+'.exe')),'fixture')}
      $installPostgres=$true;$installApplicationPostgres=$true;$script:listening=$false;$script:initialized=0;$script:installed=0
      Ensure-OnlinePostgres
      if($script:installed -ne 1 -or $script:initialized -ne 1){throw 'Client-only installation was mistaken for a running server'}
      Ensure-OnlinePostgres
      if($script:installed -ne 1 -or $script:initialized -ne 2){throw 'Complete server binaries were not reused'}
      $installPostgres=$false;Ensure-OnlinePostgres
      if($script:initialized -ne 2){throw 'Existing control server was reinitialized'}
      $installPostgres=$true;$script:listening=$true;Ensure-OnlinePostgres
      if($script:initialized -ne 2){throw 'Running PostgreSQL was reinitialized'}
      Remove-Item -LiteralPath (Join-Path $bin 'initdb.exe')
      try{Ensure-OnlinePostgres;throw 'Invalid explicit tool selection accepted'}catch{if($_.Exception.Message -notmatch 'selected PostgreSQL bin directory is incomplete'){throw}}
      $env:PG_BIN_PATH=$null;$installPostgres=$false
      try{Ensure-OnlinePostgres;throw 'Unselected control server installed'}catch{if($_.Exception.Message -notmatch 'will not install an unselected control server'){throw}}
      if($script:installed -ne 1){throw 'Reuse invoked a server installer'}
      'PASS'
    `;
    const output=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-OutputFormat','Text','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:30000});
    assert.match(output,/PASS/);
  }finally{fs.rmSync(root,{recursive:true,force:true})}
});
