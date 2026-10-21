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

test('Caddy repair preserves the legacy site and restores config and service on failure', {skip:process.platform!=='win32'},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'manager-caddy-repair-'));
  try {
    const script=`
      $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
      $env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+$env:PSModulePath
      . ${quote(path.resolve(__dirname,'../scripts/repair-manager-caddy.ps1'))}
      function Get-CimInstance {param($ClassName,$Filter); [pscustomobject]@{Name='Caddy';State=$script:serviceState;StartMode='Auto';ProcessId=8104;PathName='"C:\\Caddy\\caddy.exe" run --config "C:\\Caddy\\Caddyfile"'}}
      function Get-ItemProperty {param($LiteralPath,$Name,$ErrorAction); @{DelayedAutoStart=1}}
      function Get-NetTCPConnection {param($State,$LocalPort,$ErrorAction); if($script:serviceState -eq 'Running'){[pscustomobject]@{OwningProcess=8104}}}
      function Get-CaddyRepairPm2 {param($Context); @{pid=300;status='stopped'}}
      function Invoke-WebRequest {param($Uri,[switch]$UseBasicParsing,$TimeoutSec); @{Content='{"apps":{"http":{}}}'}}
      function Copy-Item {param($LiteralPath,$Destination,[switch]$Force); if($LiteralPath -eq 'C:\\Caddy\\Caddyfile'){$LiteralPath=Join-Path $script:fixture 'legacy'}; Microsoft.PowerShell.Management\\Copy-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force}
      function Stop-Service {param($Name,$ErrorAction); $script:events.Add('stop-legacy'); $script:serviceState='Stopped'}
      function Start-Service {param($Name,$ErrorAction); $script:events.Add('start-legacy'); $script:serviceState='Running'}
      function Set-Service {param($Name,$StartupType,$ErrorAction); $script:events.Add('startup-'+$StartupType)}
      function Start-Sleep {param($Seconds)}
      function Wait-CaddyRepairHealth {param($Context); if($script:scenario -eq 'health-failure'){throw 'TLS verification failed'}; $script:events.Add('verified')}
      function Assert-CaddyRepairHealth {param($Context); $script:events.Add('stable')}
      function Invoke-CaddyRepairNative {param($File,$Arguments)
        if($Arguments[0] -eq 'validate' -and $script:scenario -eq 'invalid'){throw 'Invalid combined configuration'}
        if($Arguments[0] -eq 'adapt'){return '{"apps":{"http":{"servers":{"https":{"listen":[":443"]},"legacy":{"listen":[":8081"]}}}}}'}
        if($File -eq 'pm2.cmd') {
          $script:events.Add($Arguments[0]+'-pm2')
          if($Arguments[0] -eq 'save') {[IO.File]::WriteAllText((Join-Path $script:fixture 'pm2/dump.pm2'),'updated'); if($script:scenario -eq 'save-failure'){throw 'PM2 save failed'}}
        }
        if($File -eq 'sc.exe'){$script:events.Add('restore-delayed')}
        if($Arguments[0] -eq 'reload'){$script:events.Add('restore-live-config')}
      }
      foreach($scenario in @('success','invalid','health-failure','save-failure')) {
        $script:scenario=$scenario; $script:fixture=Join-Path ${quote(root)} $scenario
        New-Item -ItemType Directory -Path (Join-Path $fixture 'pm2') -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $fixture 'Caddyfile'),'manager-original')
        [IO.File]::WriteAllText((Join-Path $fixture 'legacy'),'http://192.168.64.90:8081 { respond old }')
        [IO.File]::WriteAllText((Join-Path $fixture 'pm2/dump.pm2'),'original-dump')
        $script:events=[Collections.Generic.List[string]]::new(); $script:serviceState='Running'
        $context=[pscustomobject]@{Root=$fixture;Config=(Join-Path $fixture 'Caddyfile');Exe='caddy.exe';Boot=@{pm2='pm2.cmd'};Report=@{webRoot=$fixture}}
        $failed=$false
        try { Invoke-CaddyRepairSwitch $context } catch { $failed=$true; if($scenario -eq 'success' -or $_.Exception.Message -match 'Rollback needs attention'){throw} }
        $content=[IO.File]::ReadAllText($context.Config)
        if($scenario -eq 'success') {
          if($failed -or $content -notmatch 'import "C:/Caddy/Caddyfile"' -or $serviceState -ne 'Stopped'){throw 'Successful switch did not retain the site'}
          if(($events -join ',') -ne 'stop-legacy,restart-pm2,verified,stable,startup-Disabled,save-pm2'){throw ('Wrong success order: '+($events -join ','))}
        } else {
          if(-not $failed -or $content -ne 'manager-original' -or $serviceState -ne 'Running'){throw 'Failed switch lost original state'}
          if([IO.File]::ReadAllText((Join-Path $fixture 'pm2/dump.pm2')) -ne 'original-dump'){throw 'Saved startup state not restored'}
          if($scenario -eq 'invalid' -and $events.Count){throw 'Invalid config changed services'}
          if($scenario -ne 'invalid' -and -not $events.Contains('restore-live-config')){throw 'Actual runtime config not restored'}
          if($scenario -ne 'invalid' -and -not $events.Contains('restore-delayed')){throw 'Delayed automatic startup not restored'}
        }
        'PASS: '+$scenario
      }
    `;
    const result=execFileSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-OutputFormat','Text','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:30000,windowsHide:true,stdio:['ignore','pipe','pipe']});
    for(const name of ['success','invalid','health-failure','save-failure']) assert.ok(result.includes('PASS: '+name));
  } finally {removeFixture(root);}
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

test('Windows PowerShell repair validation accepts a real combined Caddyfile', {skip:process.platform!=='win32'||!process.env.MANAGER_TEST_CADDY_EXE},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'manager-caddy-repair-config-'));
  try {
    const legacy=path.join(root,'Legacy.Caddyfile'),combined=path.join(root,'Combined.Caddyfile');
    fs.writeFileSync(legacy,'http://127.0.0.1:8081 {\n respond legacy\n}\n');
    fs.writeFileSync(combined,`{\n skip_install_trust\n}\nimport "${legacy.replaceAll('\\','/')}"\nhttps://127.0.0.1 {\n tls internal\n respond manager\n}\n`);
    const script=`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; . ${quote(path.resolve(__dirname,'../scripts/repair-manager-caddy.ps1'))}; $env:XDG_DATA_HOME=${quote(path.join(root,'data'))}; $env:XDG_CONFIG_HOME=${quote(path.join(root,'config'))}; $null=Invoke-CaddyRepairNative ${quote(process.env.MANAGER_TEST_CADDY_EXE)} @('validate','--config',${quote(combined)},'--adapter','caddyfile'); $json=(Invoke-CaddyRepairNative ${quote(process.env.MANAGER_TEST_CADDY_EXE)} @('adapt','--config',${quote(combined)},'--adapter','caddyfile')) -join "\`n" | ConvertFrom-Json; @($json.apps.http.servers.PSObject.Properties | ForEach-Object {$_.Value.listen}) | ConvertTo-Json -Compress`;
    const output=execFileSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-OutputFormat','Text','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:30000,windowsHide:true,stdio:['ignore','pipe','pipe']});
    assert.deepEqual(new Set(JSON.parse(output)),new Set([':443',':8081']));
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
