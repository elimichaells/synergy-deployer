const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const quote = value => "'" + value.replaceAll("'", "''") + "'";
function powershell(script, env) {
  const executable = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ProgressPreference = 'SilentlyContinue'\n" + script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 30000, env: env || process.env,
  });
}

test('fresh-server preflight rejects unsafe paths and conflicting listeners without modifying files', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-preflight-test-'));
  const existing = path.join(root, 'existing');
  fs.mkdirSync(existing);
  fs.writeFileSync(path.join(existing, '.env.local'), 'MANAGER_ENCRYPTION_KEY=preserve-me');
  try {
    const result = powershell(`
      $ErrorActionPreference = 'Stop'
      . ${quote(path.resolve(__dirname, '../scripts/installer-preflight.ps1'))}
      if ((Get-ManagerPostgresPackage 17763) -ne 'postgresql17') { throw 'Server 2019 must use PostgreSQL 17' }
      if ((Get-ManagerPostgresPackage 20348) -ne 'postgresql18') { throw 'Server 2022 must use PostgreSQL 18' }
      if ((Get-ManagerPostgresPackage 26100) -ne 'postgresql18') { throw 'Server 2025 must use PostgreSQL 18' }
      function CheckBlocked([scriptblock]$Action, [string]$Pattern) {
        try { & $Action } catch {
          if ($_.Exception.Message -notlike $Pattern) { throw }
          return
        }
        throw ('Expected preflight rejection: ' + $Pattern)
      }
      $root = ${quote(root)}
      $manager = Join-Path $root 'web\\manager'
      $web = Join-Path $root 'web'
      $source = Join-Path $root 'package'
      Assert-ManagerInstallPaths $manager $web $source
      Assert-ManagerInstallPaths $manager $web $manager
      CheckBlocked { Assert-ManagerInstallPaths 'C:relative' $web $source } '*absolute local*'
      CheckBlocked { Assert-ManagerInstallPaths 'C:\\' $web $source } '*dedicated application*'
      CheckBlocked { Assert-ManagerInstallPaths $web $web $source } '*dedicated application*'
      CheckBlocked { Assert-ManagerInstallPaths $manager (Join-Path $manager 'web') $source } '*dedicated application*'
      CheckBlocked { Assert-ManagerInstallPaths $manager $web (Join-Path $manager 'package') } '*nested*'
      CheckBlocked { Assert-ManagerInstallPaths (Join-Path $source 'installed') $web $source } '*nested*'
      CheckBlocked { Assert-ManagerInstallPaths ${quote(existing)} $web $source } '*preserve existing encryption keys*'
      function Get-NetTCPConnection { param($State, $LocalPort, $ErrorAction) if ($LocalPort -eq $script:occupied) { [pscustomobject]@{ LocalPort=$LocalPort } } }
      $script:occupied = 0
      Assert-ManagerInstallPorts 4000 5432 $true 5433 $true $false
      foreach ($port in @(80,443,5432,5433,8432)) {
        CheckBlocked { Assert-ManagerInstallPorts $port 5432 $true 5433 $true $false } '*conflicts*'
      }
      CheckBlocked { Assert-ManagerInstallPorts 0 5432 $true 5433 $true $false } '*between 1 and 65535*'
      foreach ($port in @(4000,80,443,8432,8433)) {
        $script:occupied = $port
        CheckBlocked { Assert-ManagerInstallPorts 4000 5432 $true 5433 $true $true } '*already in use*'
      }
      $script:occupied = 8433
      Assert-ManagerInstallPorts 4000 5432 $true 5433 $true $false
      'PASS'
    `);
    assert.match(result, /PASS/);
    assert.equal(fs.readFileSync(path.join(existing, '.env.local'), 'utf8'), 'MANAGER_ENCRYPTION_KEY=preserve-me');
    assert.deepEqual(fs.readdirSync(root), ['existing']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('installer starts Manager from the installed directory on loopback even when launched from package cache', { skip: process.platform !== 'win32' }, () => {
  const script = fs.readFileSync(path.resolve(__dirname, '../scripts/install-manager.ps1'), 'utf8');
  const start = script.split(/\r?\n/).find(line => line.endsWith("'Start Manager'"));
  assert.ok(start);
  const result = JSON.parse(powershell(`
    $managerRoot = 'D:\\Web Apps\\manager'
    $managerPort = 4100
    $nextBin = Join-Path $managerRoot 'node_modules\\next\\dist\\bin\\next'
    function Invoke-Native([string]$File, [string[]]$Arguments, [string]$Label) {
      @{ file=$File; arguments=$Arguments } | ConvertTo-Json -Compress
    }
    ${start}
  `));
  const args = result.arguments;
  assert.equal(args[args.indexOf('--cwd') + 1], 'D:\\Web Apps\\manager');
  assert.deepEqual(args.slice(args.indexOf('--') + 1), ['start', '-p', '4100', '--hostname', '127.0.0.1']);
});

test('boot recovery uses saved PM2 paths without the installing user PATH and reports failures', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-startup-test-'));
  const manager = path.join(root, 'Manager');
  const bin = path.join(root, 'user npm');
  fs.mkdirSync(manager);
  fs.mkdirSync(bin);
  const pm2 = path.join(bin, 'pm2.cmd');
  const startup = path.resolve(__dirname, '../scripts/pm2-resurrect.ps1');
  const env = { ...process.env, ProgramData: root, Path: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}` };
  try {
    fs.writeFileSync(pm2, '@echo off\r\necho command=%1\r\necho pm2home=%PM2_HOME%\r\necho caddydata=%XDG_DATA_HOME%\r\necho caddyconfig=%XDG_CONFIG_HOME%\r\nwhere node.exe\r\nexit /b 0\r\n');
    fs.writeFileSync(path.join(manager, 'pm2-startup.json'), JSON.stringify({ node: process.execPath, pm2, path: env.Path, caddyDataHome: path.join(manager, 'caddy-data'), caddyConfigHome: path.join(manager, 'caddy-config') }));
    const output = powershell(`& ${quote(startup)}`, env);
    assert.match(output, /command=resurrect/);
    assert.ok(output.includes(path.join(manager, 'pm2')));
    assert.ok(output.toLowerCase().includes(process.execPath.toLowerCase()));
    assert.ok(output.includes('caddydata=' + path.join(manager, 'caddy-data')));
    assert.ok(output.includes('caddyconfig=' + path.join(manager, 'caddy-config')));
    fs.writeFileSync(pm2, '@echo off\r\nexit /b 7\r\n');
    const failure = powershell(`try { & ${quote(startup)} } catch { $_.Exception.Message }`, env);
    assert.match(failure, /boot recovery failed with exit code 7/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
