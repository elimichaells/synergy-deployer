const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const https = require('node:https');
const { createHash } = require('node:crypto');
const load = require('./server-module.cjs');
const address = require('../lib/manager-address.ts');
const loadCaddy = mocks => load('lib/caddy.ts', { './paths': require('../lib/paths.ts'), './manager-address': address, ...mocks });
const quote = value => "'" + value.replaceAll("'", "''") + "'";

const cases = [
  ['192.168.10.20', 'local', 'https://192.168.10.20', 'internal'],
  ['manager', 'local', 'https://manager', 'internal'],
  ['Deploy.Campus.Local', 'local', 'https://deploy.campus.local', 'internal'],
  ['deploy.institution.edu', 'local', 'https://deploy.institution.edu', 'internal'],
  ['deploy.example.com', 'public', 'https://deploy.example.com', 'public'],
  ['203.0.113.20', 'public', 'https://203.0.113.20', 'internal'],
  ['[2001:db8::20]', 'public', 'https://[2001:db8::20]', 'internal'],
  ['fd00::20', 'local', 'https://[fd00::20]', 'internal'],
];

test('Windows installer resolves public and institutional IP/hostname configurations and rejects unsafe addresses', { skip: process.platform !== 'win32' }, () => {
  const script = `
    $ErrorActionPreference = 'Stop'
    . ${quote(path.resolve(__dirname, '../scripts/installer-network.ps1'))}
    $cases = ${quote(JSON.stringify(cases))} | ConvertFrom-Json
    $results = @()
    foreach ($case in $cases) { $results += Get-ManagerNetworkSettings $case[0] $case[1] @('10.20.0.0/16','fd00::/64') }
    foreach ($bad in @('https://example.com','example.com:443','a/b','x{y}','host name','999.1.1.1','127.1','12345','0.0.0.0','::','224.1.1.1','fe80::1%12')) {
      $blocked = $false
      try { Get-ManagerNetworkSettings $bad | Out-Null } catch { $blocked = $true }
      if (-not $blocked) { throw ('Unsafe address was accepted: ' + $bad) }
    }
    foreach ($bad in @('Any','0.0.0.0/0','10.0.0.0/99','not-a-network')) {
      $blocked = $false
      try { Get-ManagerNetworkSettings '192.168.1.10' 'local' @($bad) | Out-Null } catch { $blocked = $true }
      if (-not $blocked) { throw ('Unsafe network was accepted: ' + $bad) }
    }
    $results | ConvertTo-Json -Depth 4 -Compress
  `;
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const results = JSON.parse(output);
  for (let index = 0; index < cases.length; index++) {
    assert.equal(results[index].Url, cases[index][2]);
    assert.equal(results[index].TlsMode, cases[index][3]);
    assert.deepEqual(results[index].RemoteAddresses, cases[index][1] === 'local' ? ['10.20.0.0/16', 'fd00::/64'] : ['Any']);
    assert.doesNotMatch(results[index].LogName, /[:\[\]]/);
  }
});

test('local HTTPS remains trusted with the same CA after a Caddy restart', { skip: !process.env.MANAGER_TEST_CADDY_EXE, timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-network-tls-'));
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const caPath = path.join(root, 'data/caddy/pki/authorities/local/root.crt');
  const filename = path.join(root, 'Caddyfile');
  fs.writeFileSync(filename, `{\n admin off\n auto_https disable_redirects\n skip_install_trust\n}\nhttps://127.0.0.1:${port} {\n bind 127.0.0.1\n tls internal\n respond "verified"\n}\n`);
  let child;
  let output = '';
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
  };
  const start = async () => {
    child = spawn(process.env.MANAGER_TEST_CADDY_EXE, ['run','--config',filename,'--adapter','caddyfile'], {
      windowsHide: true, stdio: ['ignore','ignore','pipe'],
      env: { ...process.env, XDG_DATA_HOME: path.join(root, 'data'), XDG_CONFIG_HOME: path.join(root, 'config') },
    });
    child.stderr.on('data', data => { output += data.toString(); });
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) throw new Error('Isolated Caddy exited: ' + output);
      try {
        const ca = fs.readFileSync(caPath);
        const status = await new Promise((resolve, reject) => {
          const request = https.get({ hostname: '127.0.0.1', port, ca, rejectUnauthorized: true, timeout: 1000 }, response => {
            response.resume(); resolve(response.statusCode);
          });
          request.on('error', reject);
          request.on('timeout', () => request.destroy(new Error('TLS request timed out')));
        });
        assert.equal(status, 200);
        return createHash('sha256').update(ca).digest('hex');
      } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    throw new Error('Local HTTPS did not become ready: ' + output);
  };
  try {
    const firstCa = await start();
    await stop();
    assert.equal(await start(), firstCa, 'Restart replaced the trusted local root certificate');
  } finally {
    await stop();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'manager-network-tls-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Manager links and regenerated proxy routes retain address and certificate mode', () => {
  const saved = Object.fromEntries(['MANAGER_DOMAIN','MANAGER_ACCESS_MODE','MANAGER_TLS_MODE'].map(key => [key, process.env[key]]));
  const caddy = loadCaddy({ './exec': { runCommand: async () => ({ code: 0, output: '' }) } });
  try {
    for (const [host, mode, url, tls] of cases) {
      process.env.MANAGER_DOMAIN = address.normalizeManagerAddress(host);
      process.env.MANAGER_ACCESS_MODE = mode;
      process.env.MANAGER_TLS_MODE = tls;
      assert.equal(address.managerUrl(), url);
      const block = caddy.renderCaddyBlock(process.env.MANAGER_DOMAIN, 4000);
      assert.ok(block.includes(`${url.slice('https://'.length)} {`));
      assert.equal(block.includes('tls internal'), tls === 'internal');
      assert.match(block, /forward_auth 127\.0\.0\.1:4000/);
      assert.match(block, /reverse_proxy 127\.0\.0\.1:4000/);
      assert.equal(caddy.renderCaddyBlock('unrelated.example.com', 4100).includes('tls internal'), false);
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('reconciling an IPv6 Manager host replaces its block without losing the local issuer', async () => {
  const content = '# fd00::20\n[fd00::20] {\n reverse_proxy 127.0.0.1:3999\n}\n';
  let written;
  const original = process.env.MANAGER_DOMAIN;
  process.env.MANAGER_DOMAIN = 'fd00::20';
  const caddy = loadCaddy({
    'fs/promises': { mkdtemp: async () => 'C:\\fake-test', readFile: async () => content, writeFile: async (_file, value) => { written = value; }, rm: async () => {} },
    './exec': { runCommand: async () => ({ code: 0, output: '' }) },
    './db': { query: async () => ({ rows: [] }) },
  });
  try {
    await caddy.updateCaddyStrict('fd00::20', 4000);
    assert.equal(written.split('[fd00::20] {').length, 2);
    assert.match(written, /tls internal/);
    assert.doesNotMatch(written, /3999/);
  } finally { if (original === undefined) delete process.env.MANAGER_DOMAIN; else process.env.MANAGER_DOMAIN = original; }
});

test('Caddy accepts the rendered local/IP configuration', { skip: !process.env.MANAGER_TEST_CADDY_EXE }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-network-caddy-'));
  const original = process.env.MANAGER_DOMAIN;
  const caddy = loadCaddy({ './exec': { runCommand: async () => ({ code: 0, output: '' }) } });
  try {
    for (const host of ['192.168.10.20','fd00::20','manager']) {
      process.env.MANAGER_DOMAIN = host;
      const filename = path.join(root, 'Caddyfile');
      fs.writeFileSync(filename, caddy.renderCaddyBlock(host, 4000));
      const result = JSON.parse(execFileSync(process.env.MANAGER_TEST_CADDY_EXE, ['adapt','--config',filename,'--adapter','caddyfile'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore','pipe','pipe'] }));
      assert.equal(result.apps.tls.automation.policies[0].issuers[0].module, 'internal');
    }
  } finally {
    if (original === undefined) delete process.env.MANAGER_DOMAIN; else process.env.MANAGER_DOMAIN = original;
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'manager-network-caddy-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
