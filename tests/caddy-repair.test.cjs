const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { check } = require('../scripts/caddy-repair-check.cjs');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
function removeFixture(root) {
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'manager-caddy-repair-')) throw Error('Unsafe fixture cleanup');
  fs.rmSync(root,{recursive:true,force:true});
}

test('Caddy repair preserves or retires the test site and rolls back either prior service owner', {skip:process.platform!=='win32'},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'manager-caddy-repair-'));
  try {
    const script=`
      $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
      $env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+$env:PSModulePath
      . ${quote(path.resolve(__dirname,'../scripts/repair-manager-caddy.ps1'))}
      function Get-CimInstance {param($ClassName,$Filter); [pscustomobject]@{Name='Caddy';State=$script:serviceState;StartMode=$script:serviceMode;ProcessId=8104;PathName='"C:\\Caddy\\caddy.exe" run --config "C:\\Caddy\\Caddyfile"'}}
      function Get-ItemProperty {param($LiteralPath,$Name,$ErrorAction); @{DelayedAutoStart=1}}
      function Get-NetTCPConnection {param($State,$LocalPort,$ErrorAction); if($script:serviceState -eq 'Running'){[pscustomobject]@{OwningProcess=8104}} elseif($script:managerState -eq 'online'){[pscustomobject]@{OwningProcess=300}}}
      function Get-CaddyRepairPm2 {param($Context); @{pid=300;status=$script:managerState}}
      function Invoke-WebRequest {param($Uri,[switch]$UseBasicParsing,$TimeoutSec); @{Content='{"apps":{"http":{}}}'}}
      function Copy-Item {param($LiteralPath,$Destination,[switch]$Force); if($LiteralPath -eq 'C:\\Caddy\\Caddyfile'){$LiteralPath=Join-Path $script:fixture 'legacy'}; Microsoft.PowerShell.Management\\Copy-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force}
      function Stop-Service {param($Name,$ErrorAction); $script:events.Add('stop-legacy'); $script:serviceState='Stopped'}
      function Start-Service {param($Name,$ErrorAction); $script:events.Add('start-legacy'); $script:serviceState='Running'}
      function Set-Service {param($Name,$StartupType,$ErrorAction); $script:events.Add('startup-'+$StartupType); $script:serviceMode=if($StartupType -eq 'Automatic'){'Auto'}else{$StartupType}}
      function Start-Sleep {param($Seconds)}
      function Wait-CaddyRepairHealth {param($Context); if($script:scenario -eq 'health-failure'){throw 'TLS verification failed'}; $script:events.Add('verified')}
      function Assert-CaddyRepairHealth {param($Context); $script:events.Add('stable')}
      function Invoke-CaddyRepairNative {param($File,$Arguments)
        if($Arguments[0] -eq 'validate' -and $script:scenario -eq 'invalid'){throw 'Invalid combined configuration'}
        if($Arguments[0] -eq 'adapt'){
          $text=[IO.File]::ReadAllText($Arguments[2])
          if($text.Contains('import "C:/Caddy/Caddyfile"') -or $script:scenario -eq 'retained-test'){return '{"apps":{"http":{"servers":{"https":{"listen":[":443"]},"legacy":{"listen":[":8081"]}}}}}'}
          return '{"apps":{"http":{"servers":{"https":{"listen":[":443"]}}}}}'
        }
        if($File -eq 'pm2.cmd') {
          $script:events.Add($Arguments[0]+'-pm2')
          if($Arguments[0] -eq 'restart'){$script:managerState='online'}
          if($Arguments[0] -eq 'stop'){$script:managerState='stopped'}
          if($Arguments[0] -eq 'save') {[IO.File]::WriteAllText((Join-Path $script:fixture 'pm2/dump.pm2'),'updated'); if($script:scenario -eq 'save-failure'){throw 'PM2 save failed'}}
        }
        if($File -eq 'sc.exe'){$script:events.Add('restore-delayed')}
        if($Arguments[0] -eq 'reload'){$script:events.Add('restore-live-config')}
      }
      foreach($mode in @('preserve','retire-fresh','retire-previous')) {
      foreach($scenario in @('success','invalid','health-failure','save-failure','retained-test')) {
        if($mode -eq 'preserve' -and $scenario -eq 'retained-test'){continue}
        $script:scenario=$scenario; $script:fixture=Join-Path ${quote(root)} ($mode+'-'+$scenario)
        New-Item -ItemType Directory -Path (Join-Path $fixture 'pm2') -Force | Out-Null
        $initialConfig=if($mode -eq 'retire-previous'){'import "C:/Caddy/Caddyfile"'+"\`r\`n"+'manager-original'}else{'manager-original'}
        [IO.File]::WriteAllText((Join-Path $fixture 'Caddyfile'),$initialConfig)
        [IO.File]::WriteAllText((Join-Path $fixture 'legacy'),'http://192.168.64.90:8081 { respond old }')
        [IO.File]::WriteAllText((Join-Path $fixture 'pm2/dump.pm2'),'original-dump')
        $script:events=[Collections.Generic.List[string]]::new()
        $initialState=if($mode -eq 'retire-previous'){'Stopped'}else{'Running'}
        $initialMode=if($mode -eq 'retire-previous'){'Disabled'}else{'Auto'}
        $initialManager=if($mode -eq 'retire-previous'){'online'}else{'stopped'}
        $script:serviceState=$initialState; $script:serviceMode=$initialMode; $script:managerState=$initialManager
        $context=[pscustomobject]@{Root=$fixture;Config=(Join-Path $fixture 'Caddyfile');Exe='caddy.exe';Boot=@{pm2='pm2.cmd'};Report=@{webRoot=$fixture};RetireTestSite=($mode -ne 'preserve')}
        $failed=$false
        try { Invoke-CaddyRepairSwitch $context } catch { $failed=$true; if($scenario -eq 'success' -or $_.Exception.Message -match 'Rollback needs attention'){throw} }
        $content=[IO.File]::ReadAllText($context.Config)
        if($scenario -eq 'success') {
          $expectedConfig=if($mode -eq 'preserve'){'import "C:/Caddy/Caddyfile"'+"\`r\`n\`r\`n"+'manager-original'}else{'manager-original'}
          if($failed -or $content -ne $expectedConfig -or $serviceState -ne 'Stopped' -or $serviceMode -ne 'Disabled' -or $managerState -ne 'online'){throw 'Successful switch did not produce the expected configuration'}
          $firstEvent=if($mode -eq 'retire-previous'){'stop-pm2'}else{'stop-legacy'}
          if(($events -join ',') -ne ($firstEvent+',restart-pm2,verified,stable,startup-Disabled,save-pm2')){throw ('Wrong success order: '+($events -join ','))}
        } else {
          if(-not $failed -or $content -ne $initialConfig -or $serviceState -ne $initialState -or $serviceMode -ne $initialMode -or $managerState -ne $initialManager){throw 'Failed switch lost original state'}
          if([IO.File]::ReadAllText((Join-Path $fixture 'pm2/dump.pm2')) -ne 'original-dump'){throw 'Saved startup state not restored'}
          $preflightFailure=$scenario -in @('invalid','retained-test')
          if($preflightFailure -and $events.Count){throw 'Invalid config changed services'}
          if(-not $preflightFailure -and -not $events.Contains('restore-live-config')){throw 'Actual runtime config not restored'}
          if(-not $preflightFailure -and $mode -ne 'retire-previous' -and -not $events.Contains('restore-delayed')){throw 'Delayed automatic startup not restored'}
          if($mode -eq 'retire-previous' -and $events.Contains('start-legacy')){throw 'Rollback restarted the retired legacy service'}
        }
        'PASS: '+$mode+'-'+$scenario
      }
      }
    `;
    const result=execFileSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-OutputFormat','Text','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:30000,windowsHide:true,stdio:['ignore','pipe','pipe']});
    for(const mode of ['preserve','retire-fresh','retire-previous']) {
      for(const name of ['success','invalid','health-failure','save-failure',...(mode==='preserve'?[]:['retained-test'])]) assert.ok(result.includes('PASS: '+mode+'-'+name));
    }
  } finally {removeFixture(root);}
});

test('retired-site health check verifies Manager port ownership and rejects a surviving test listener', {skip:process.platform!=='win32'},()=>{
  const script=`
    $ErrorActionPreference='Stop'
    . ${quote(path.resolve(__dirname,'../scripts/repair-manager-caddy.ps1'))}
    function Get-CaddyRepairPm2 {param($Context); @{pid=300;status=$(if($script:scenario -eq 'offline'){'stopped'}else{'online'})}}
    function Get-CimInstance {param($ClassName,$Filter); @{ExecutablePath='manager-caddy.exe'}}
    function Invoke-CaddyRepairNative {param($File,$Arguments); $script:httpsVerified=$true}
    function Get-NetTCPConnection {param($State,$LocalPort,$ErrorAction)
      if($LocalPort -eq 443 -and $script:scenario -eq 'missing-https'){return}
      if($LocalPort -eq 8081){
        if($script:scenario -eq 'test-still-running'){[pscustomobject]@{OwningProcess=300}}
        if($script:scenario -eq 'unrelated-8081'){[pscustomobject]@{OwningProcess=999}}
        return
      }
      [pscustomobject]@{OwningProcess=$(if($script:scenario -eq 'foreign-owner'){999}else{300})}
    }
    foreach($scenario in @('success','unrelated-8081','offline','missing-https','foreign-owner','test-still-running')) {
      $script:scenario=$scenario; $script:httpsVerified=$false
      $context=@{RetireTestSite=$true;Exe='manager-caddy.exe';Boot=@{node='node.exe'};Helper='check.cjs';Root='fixture'}
      $failed=$false
      try{Assert-CaddyRepairHealth $context}catch{$failed=$true}
      $expectedSuccess=$scenario -in @('success','unrelated-8081')
      if($failed -eq $expectedSuccess -or $httpsVerified -ne $expectedSuccess){throw ('Unexpected health result: '+$scenario)}
      'PASS: '+$scenario
    }
  `;
  const output=execFileSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-OutputFormat','Text','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:30000,windowsHide:true,stdio:['ignore','pipe','pipe']});
  for(const name of ['success','unrelated-8081','offline','missing-https','foreign-owner','test-still-running']) assert.ok(output.includes('PASS: '+name));
});

test('repair PM2 inspection rejects foreign installations and returns no environment secrets', async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'manager-caddy-repair-pm2-'));
  try {
    const managerRoot=path.join(root,'app'),webRoot=path.join(root,'web'),rowsFile=path.join(root,'rows.json');
    fs.mkdirSync(path.join(managerRoot,'scripts'),{recursive:true});
    fs.writeFileSync(path.join(managerRoot,'scripts/server-monitor.cjs'),`exports.readPm2=async()=>JSON.parse(require('fs').readFileSync(${JSON.stringify(rowsFile)},'utf8'));`);
    fs.writeFileSync(path.join(root,'pm2-startup.json'),JSON.stringify({pm2:path.join(root,'tools/pm2.cmd')}));
    fs.writeFileSync(path.join(root,'install-report.json'),JSON.stringify({managerRoot,webRoot}));
    const row={name:'manager-caddy',pid:123,pm2_env:{status:'online',pm_exec_path:path.join(webRoot,'caddy.exe'),PM2_HOME:path.join(root,'pm2'),DATABASE_PASSWORD:'must-not-print'}};
    const save=rows=>fs.writeFileSync(rowsFile,JSON.stringify(rows));save([row]);
    assert.deepEqual(await check('pm2',root),{name:row.name,pid:123,status:'online',executable:row.pm2_env.pm_exec_path});
    save([row,row]);await assert.rejects(check('pm2',root),/exactly one/);
    row.pm2_env.PM2_HOME=path.join(root,'foreign');save([row]);await assert.rejects(check('pm2',root),/another daemon home/);
    row.pm2_env.pm_exec_path=path.join(root,'foreign/caddy.exe');save([row]);await assert.rejects(check('pm2',root),/different Caddy installation/);
  } finally {removeFixture(root);}
});

test('Windows PowerShell repair validation accepts preserved and retired site configurations', {skip:process.platform!=='win32'||!process.env.MANAGER_TEST_CADDY_EXE},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'manager-caddy-repair-config-'));
  try {
    const legacy=path.join(root,'Legacy.Caddyfile');
    fs.writeFileSync(legacy,'http://127.0.0.1:8081 {\n respond legacy\n}\n');
    for(const retire of [false,true]) {
    const combined=path.join(root,retire?'Retired.Caddyfile':'Combined.Caddyfile');
    const include=retire?'':`import "${legacy.replaceAll('\\','/')}"\n`;
    fs.writeFileSync(combined,`{\n skip_install_trust\n}\n${include}https://127.0.0.1 {\n tls internal\n respond manager\n}\n`);
    const script=`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; . ${quote(path.resolve(__dirname,'../scripts/repair-manager-caddy.ps1'))}; $env:XDG_DATA_HOME=${quote(path.join(root,'data'))}; $env:XDG_CONFIG_HOME=${quote(path.join(root,'config'))}; $null=Invoke-CaddyRepairNative ${quote(process.env.MANAGER_TEST_CADDY_EXE)} @('validate','--config',${quote(combined)},'--adapter','caddyfile'); $json=(Invoke-CaddyRepairNative ${quote(process.env.MANAGER_TEST_CADDY_EXE)} @('adapt','--config',${quote(combined)},'--adapter','caddyfile')) -join "\`n" | ConvertFrom-Json; @($json.apps.http.servers.PSObject.Properties | ForEach-Object {$_.Value.listen}) | ConvertTo-Json -Compress`;
    const output=execFileSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-OutputFormat','Text','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:30000,windowsHide:true,stdio:['ignore','pipe','pipe']});
    const ports=JSON.parse(output);
    assert.deepEqual(new Set(Array.isArray(ports)?ports:[ports]),new Set(retire?[':443']:[':443',':8081']));
    }
  } finally {removeFixture(root);}
});

test('repair HTTPS check verifies the actual Caddy certificate, hostname and login response', {skip:!process.env.MANAGER_TEST_CADDY_EXE},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'manager-caddy-repair-https-'));
  let child;
  try {
    const socket=net.createServer(); socket.listen(0,'127.0.0.1'); await once(socket,'listening');
    const port=socket.address().port; await new Promise(resolve=>socket.close(resolve));
    const config=path.join(root,'Caddyfile'),data=path.join(root,'data');
    fs.writeFileSync(config,`{\n admin off\n auto_https disable_redirects\n skip_install_trust\n}\nhttps://127.0.0.1:${port} {\n tls internal\n respond /login 200\n}\n`);
    child=spawn(process.env.MANAGER_TEST_CADDY_EXE,['run','--config',config,'--adapter','caddyfile'],{windowsHide:true,stdio:'ignore',env:{...process.env,XDG_DATA_HOME:data,XDG_CONFIG_HOME:path.join(root,'config')}});
    const boot={caddyDataHome:data};
    const report={tlsMode:'internal',managerUrl:`https://127.0.0.1:${port}`};
    fs.writeFileSync(path.join(root,'pm2-startup.json'),JSON.stringify(boot));
    const save=()=>fs.writeFileSync(path.join(root,'install-report.json'),JSON.stringify(report));save();
    let result,lastError;
    for(let i=0;i<40;i++){try{result=await check('https',root);break}catch(error){lastError=error;await new Promise(resolve=>setTimeout(resolve,250))}}
    assert.ok(result,lastError?.message); assert.equal(result.certificateVerified,true);assert.equal(result.status,200);
    const rootCert=path.join(data,'caddy/pki/authorities/local/root.crt');
    fs.writeFileSync(rootCert,'invalid certificate');
    await assert.rejects(check('https',root));
  } finally {
    if(child && child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
    removeFixture(root);
  }
});
