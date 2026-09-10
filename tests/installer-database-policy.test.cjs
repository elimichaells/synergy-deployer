const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('installer rejects conflicting database selections before host provisioning', { skip: process.platform !== 'win32' }, () => {
  const policy = path.resolve(__dirname, '../scripts/installer-database-policy.ps1').replaceAll("'", "''");
  const script = `
    $ErrorActionPreference = 'Stop'
    . '${policy}'
    $mysql = [pscustomobject]@{Name='MySQL';DisplayName='MySQL';PathName='C:\\mysql\\bin\\mysqld.exe'}
    $maria = [pscustomobject]@{Name='MySQL';DisplayName='MySQL';PathName='"C:\\Program Files\\MariaDB 12.3\\bin\\mysqld.exe"'}
    @{
      both = Get-ManagerDatabaseConflict @('mysql','mariadb') @()
      mariaOnMysql = Get-ManagerDatabaseConflict @('mariadb') @($mysql)
      mysqlOnMaria = Get-ManagerDatabaseConflict @('mysql') @($maria)
      reuseMysql = Get-ManagerDatabaseConflict @('mysql') @($mysql)
      reuseMaria = Get-ManagerDatabaseConflict @('mariadb') @($maria)
      noOptional = Get-ManagerDatabaseConflict @() @($mysql,$maria)
      freshMysql = Get-ManagerDatabaseConflict @('mysql') @()
      freshMaria = Get-ManagerDatabaseConflict @('mariadb') @()
    } | ConvertTo-Json -Compress
  `;
  const result = JSON.parse(execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15000 }));
  assert.match(result.both, /Choose either MySQL or MariaDB/);
  assert.match(result.mariaOnMysql, /MySQL is already installed/);
  assert.match(result.mysqlOnMaria, /MariaDB is already installed/);
  for (const key of ['reuseMysql', 'reuseMaria', 'noOptional', 'freshMysql', 'freshMaria']) assert.equal(result[key], null, key);
});
