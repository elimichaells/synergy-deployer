const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const installer = path.resolve(__dirname, '../scripts/install-manager.ps1');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
function powershell(script) {
  const setup = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $tokens=$null; $errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile(${quote(installer)},[ref]$tokens,[ref]$errors)
    if($errors.Count){throw $errors[0]}
    foreach($name in @('Get-Setting','Get-BoolSetting','Get-ListSetting')) {
      $definition=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
      Invoke-Expression $definition.Extent.Text
    }
    $Unattended=$true
    function Read-Host { throw 'Configured value unexpectedly prompted for input' }
  `;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^MANAGER_INSTALL_/i.test(name)));
  return execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo','-NoProfile','-NonInteractive','-OutputFormat','Text','-EncodedCommand',Buffer.from(setup + script,'utf16le').toString('base64')],
    {encoding:'utf8',windowsHide:true,timeout:30000,env,stdio:['ignore','pipe','pipe']});
}

test('installer preserves unchecked JSON options, zero and empty lists over defaults and environment', {skip:process.platform!=='win32'}, () => {
  const result=JSON.parse(powershell(`
    $script:Config='{"InstallPostgreSQL":false,"InstallApplicationPostgreSQL":false,"InstallPgweb":false,"InstallLatestNpm":false,"OfflineInstall":false,"Number":0,"OptionalRuntimes":[]}' | ConvertFrom-Json
    $env:MANAGER_INSTALL_INSTALLPOSTGRESQL='true'
    $values=@{}
    foreach($name in @('InstallPostgreSQL','InstallApplicationPostgreSQL','InstallPgweb','InstallLatestNpm','OfflineInstall')) {
      $values[$name]=Get-BoolSetting $name $true
    }
    $values.Number=Get-Setting 'Number' 42 -Required
    $values.OptionalRuntimes=@(Get-ListSetting 'OptionalRuntimes' @('python'))
    $Unattended=$false
    $values.Interactive=Get-BoolSetting 'InstallPostgreSQL' $true
    $values.Required=Get-Setting 'InstallPostgreSQL' $true -Required
    $values | ConvertTo-Json -Compress
  `));
  assert.deepEqual(result, {InstallPostgreSQL:false,InstallApplicationPostgreSQL:false,InstallPgweb:false,InstallLatestNpm:false,OfflineInstall:false,Number:0,OptionalRuntimes:[],Interactive:false,Required:false});
});

test('installer keeps missing-value fallbacks, environment overrides and boolean validation', {skip:process.platform!=='win32'}, () => {
  const result=JSON.parse(powershell(`
    $script:Config='{"Missing":null,"Blank":"  ","Enabled":true,"Invalid":"perhaps","DisabledText":"false"}' | ConvertFrom-Json
    $env:MANAGER_INSTALL_MISSING='false'
    $values=@{
      Environment=Get-BoolSetting 'Missing' $true
      Blank=Get-Setting 'Blank' 'default'
      DefaultTrue=Get-BoolSetting 'AbsentTrue' $true
      DefaultFalse=Get-BoolSetting 'AbsentFalse' $false
      ExplicitTrue=Get-BoolSetting 'Enabled' $false
      ExplicitText=Get-BoolSetting 'DisabledText' $true
    }
    try { $null=Get-BoolSetting 'Invalid' $true; throw 'Invalid boolean accepted' }
    catch { if($_.Exception.Message -notmatch 'must be true or false'){throw}; $values.InvalidRejected=$true }
    try { $null=Get-Setting 'AbsentRequired' $null -Required; throw 'Required value accepted' }
    catch { if($_.Exception.Message -notmatch 'is required'){throw}; $values.RequiredRejected=$true }
    $values | ConvertTo-Json -Compress
  `));
  assert.deepEqual(result,{Environment:false,Blank:'default',DefaultTrue:true,DefaultFalse:false,ExplicitTrue:true,ExplicitText:false,InvalidRejected:true,RequiredRejected:true});
});

test('unchecked control PostgreSQL passes an occupied port and skips initialization while installing the project cluster', {skip:process.platform!=='win32'}, () => {
  const result=JSON.parse(powershell(`
    $script:Config='{"InstallPostgreSQL":false,"InstallApplicationPostgreSQL":true}' | ConvertFrom-Json
    $offlineInstall=$true
    $installPostgres=Get-BoolSetting 'InstallPostgreSQL' $true
    $installApplicationPostgres=Get-BoolSetting 'InstallApplicationPostgreSQL' $true
    $dbPort=5432
    function Get-NetTCPConnection {param($State,$LocalPort,$ErrorAction); [pscustomobject]@{LocalPort=$LocalPort;OwningProcess=1924}}
    $guard=$ast.Find({param($n) $n -is [Management.Automation.Language.IfStatementAst] -and $n.Extent.Text.Contains("throw 'Control PostgreSQL port is occupied.") -and $n.Clauses[0].Item1.Extent.Text.StartsWith('$installPostgres')},$true)
    if(-not $guard){throw 'Control database preflight guard missing'}
    Invoke-Expression $guard.Extent.Text
    function Write-Step {param($Message)}
    function Install-ManagerOfflineTools {param($Bundle,$Root); @{postgresql='bundled'}}
    function Save-ManagerOfflineServiceBundle {param($Bundle,$Destination)}
    function Initialize-ManagerOfflineControlPostgres {throw 'Existing database must not be initialized'}
    function Initialize-ApplicationPostgres {$script:projectInitialized=$true}
    function Add-Result {param($Check,$Status,$Detail)}
    function Ensure-Chocolatey {throw 'Offline setup attempted Chocolatey'}
    function Invoke-Native {throw 'Unexpected external command'}
    $branch=$ast.Find({param($n) $n -is [Management.Automation.Language.IfStatementAst] -and $n.Clauses[0].Item1.Extent.Text -eq '$offlineInstall' -and $n.Clauses[0].Item2.Extent.Text.Contains('Install-ManagerOfflineTools')},$true)
    if(-not $branch){throw 'Offline installation branch missing'}
    Invoke-Expression $branch.Extent.Text
    $installPostgres=$true
    try { Invoke-Expression $guard.Extent.Text; throw 'Conflicting new installation accepted' }
    catch { if($_.Exception.Message -notmatch 'Control PostgreSQL port is occupied'){throw} }
    @{ReusedControl=$true;InitializedProjects=$script:projectInitialized;ConflictRejected=$true} | ConvertTo-Json -Compress
  `));
  assert.deepEqual(result,{ReusedControl:true,InitializedProjects:true,ConflictRejected:true});
});
