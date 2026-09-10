const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('real MySQL service repair initializes only empty data and preserves records across re-registration', {
  skip: process.platform !== 'win32' || process.env.MANAGER_TEST_MYSQL !== '1', timeout: 240000,
}, () => {
  const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'mysql-service-integration.ps1')], {
    encoding: 'utf8', windowsHide: true, timeout: 230000,
  });
  assert.match(output, /PASS: fresh initialization, existing service reuse, preserved SQL records after service repair/);
});
