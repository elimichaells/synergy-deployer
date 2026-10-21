const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const helper = path.resolve(__dirname, '../scripts/installer-offline.ps1');
function powershell(script) {
  return execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile','-NonInteractive','-OutputFormat','Text','-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+$env:PSModulePath\n. " + quote(helper) + '\n' + script,'utf16le').toString('base64')], {encoding:'utf8',windowsHide:true,timeout:60000,stdio:['ignore','pipe','pipe']});
}
test('offline PostgreSQL password file escapes delimiters and rejects multiple entries', {skip:process.platform!=='win32'},()=>{
  const output=powershell(`
    Get-ManagerPgpassEntry '127.0.0.1' 5432 'postgres' 'p:a\\ssÄ'
    try { Get-ManagerPgpassEntry '127.0.0.1' 5432 'postgres' "bad\`nentry"; throw 'accepted newline' } catch { if($_.Exception.Message -notmatch 'line breaks'){throw}; 'REJECTED' }
  `);
  assert.ok(output.includes('127.0.0.1:5432:*:postgres:p\\:a\\\\ssÄ'));
  assert.match(output,/REJECTED/);
});
test('offline preflight rejects incomplete, altered and mismatched bundles before provisioning', {skip:process.platform!=='win32'}, () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'manager-offline-check-'));
  const ids=['application','node','git','caddy','postgresql','pm2','sling','vcredist','php','composer','pgweb'];
  const artifacts=ids.map(id=>{const data=Buffer.from(id);fs.writeFileSync(path.join(root,id+'.zip'),data);return {id,version:'1',file:id+'.zip',bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')}});
  const manifest={schemaVersion:1,architecture:'win-x64',minimumWindowsBuild:17763,managerVersion:'2.19.0',packageLockSha256:'abc',artifacts};
  const save=()=>fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest));
  const check=(version='2.19.0',hash='abc',runtimes="@('composer')",engines='@()',pgweb='$true')=>powershell(`try { $bundle=Read-ManagerOfflineBundle ${quote(root)} '${version}' '${hash}' ${runtimes} ${engines} ${pgweb}; 'PASS:' + ($bundle.Required -join ',') } catch { 'REJECT:' + $_.Exception.Message }`);
  try {
    save();assert.match(check(),/^PASS:.*php/m);
    assert.match(check('2.18.0'),/REJECT:.*does not match/);
    assert.match(check('2.19.0','other'),/REJECT:.*does not match/);
    assert.match(check('2.19.0','abc',"@('python')"),/not bundled: python/);
    assert.match(check('2.19.0','abc','@()',"@('mysql')"),/Install optional databases from the Manager dashboard/);
    fs.writeFileSync(path.join(root,'node.zip'),'NODE');assert.match(check(),/failed SHA-256 verification: node/);
    fs.writeFileSync(path.join(root,'node.zip'),'node');fs.unlinkSync(path.join(root,'git.zip'));assert.match(check(),/component is missing: git/);
    fs.writeFileSync(path.join(root,'git.zip'),'git');manifest.artifacts.push({...artifacts[0]});save();assert.match(check(),/duplicate offline component/);
    manifest.artifacts.pop();manifest.artifacts[0].file='../application.zip';save();assert.match(check(),/Invalid offline bundle path/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('offline archive extraction blocks traversal and ADS before writing any files', {skip:process.platform!=='win32'},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'manager-offline-zip-'));
  try {
    const result=powershell(`
      Add-Type -AssemblyName System.IO.Compression.FileSystem,System.IO.Compression
      $root=${quote(root)}
      foreach($bad in @('../outside.txt','C:/outside.txt','ok.txt:stream','nested/../../outside.txt')) {
        $file=Join-Path $root ([guid]::NewGuid().ToString()+'.zip')
        $zip=[IO.Compression.ZipFile]::Open($file,[IO.Compression.ZipArchiveMode]::Create)
        $null=$zip.CreateEntry('valid.txt'); $null=$zip.CreateEntry($bad); $zip.Dispose()
        $target=Join-Path $root 'out'
        try { Expand-ManagerOfflineArchive $file $target; throw 'Accepted unsafe archive' } catch { if($_.Exception.Message -notmatch 'Invalid offline bundle path'){throw} }
        if(Test-Path -LiteralPath $target){throw 'Archive wrote files before validation'}
      }
      $file=Join-Path $root 'valid.zip'
      $zip=[IO.Compression.ZipFile]::Open($file,[IO.Compression.ZipArchiveMode]::Create)
      $entry=$zip.CreateEntry('.next/BUILD_ID');$writer=[IO.StreamWriter]::new($entry.Open());$writer.Write('prebuilt');$writer.Dispose();$zip.Dispose()
      Expand-ManagerOfflineArchive $file (Join-Path $root 'out')
      Get-Content -LiteralPath (Join-Path $root 'out/.next/BUILD_ID')
    `);assert.match(result,/prebuilt/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('offline installation branch installs only local tools and skips online dependency commands', {skip:process.platform!=='win32'},()=>{
  const installer=path.resolve(__dirname,'../scripts/install-manager.ps1');
  const result=powershell(`
    $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(${quote(installer)},[ref]$tokens,[ref]$errors)
    if($errors.Count){throw $errors[0]}
    $branch=$ast.FindAll({param($n) $n -is [Management.Automation.Language.IfStatementAst] -and $n.Clauses[0].Item1.Extent.Text -eq '$offlineInstall' -and $n.Clauses[0].Item2.Extent.Text.Contains('Install-ManagerOfflineTools')},$true)[0]
    if(-not $branch){throw 'Offline provisioning branch missing'}
    function Write-Step {param($Message)}
    function Install-ManagerOfflineTools {param($Bundle,$ToolsRoot); @{postgresql='local'}}
    function Save-ManagerOfflineServiceBundle {param($Bundle,$Destination); Write-Host 'local-service-packages'}
    function Initialize-ManagerOfflineControlPostgres {param($Bin,$Data,$Port,$User,$Password); Write-Host 'local-control'}
    function Initialize-ApplicationPostgres {Write-Host 'local-application'}
    function Add-Result {param($Check,$Status,$Detail);Write-Host $Detail}
    function Ensure-Chocolatey {throw 'Network bootstrap executed'}
    function Invoke-Native {throw 'Unexpected online command executed'}
    function Invoke-WebRequest {throw 'Network request executed'}
    $offlineInstall=$true;$installPostgres=$true;$installApplicationPostgres=$true
    Invoke-Expression $branch.Extent.Text
  `);assert.match(result,/local-control/);assert.match(result,/local-application/);assert.match(result,/bundled Node/);
});
