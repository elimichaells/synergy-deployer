'use strict';

// Destructive provisioning belongs only on the disposable runners prepared by
// this workflow. No production Manager credentials or database are ever loaded.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function guard() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Only run on a disposable GitHub runner');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(process.env.MANAGER_SSH_LAB, '1');
  const database = new URL(process.env.DATABASE_URL);
  assert.equal(database.hostname, '127.0.0.1');
  assert.equal(database.pathname, '/manager_remote_test_ssh');
  assert.ok(process.env.SSH_LAB_PASSWORD && process.env.SSH_LAB_FINGERPRINT);
  assert.ok(['win32', 'linux'].includes(process.platform));
  assert.ok(!fs.existsSync(path.join(root, '.env.local')), 'Never load an installed Manager checkout');
}

async function main() {
  guard();
  process.chdir(root);
  process.env.MANAGER_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  require('../register.cjs');
  const Module = require('node:module');
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (id, parent, ...args) {
    return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, parent, ...args);
  };
  // These are the real Manager modules and agent HTTP route, without mocks.
  const { db } = require('../../lib/db.ts');
  const managed = require('../../lib/managed-servers.ts');
  const ssh = require('../../lib/server-ssh.ts');
  const agentRoute = require('../../app/api/server-agent/[action]/route.ts');
  const { redact } = require('../../scripts/manager-agent.cjs');
  const secrets = [process.env.SSH_LAB_PASSWORD];
  const target = { host: '127.0.0.1', port: 2222, username: 'managersmoke' };
  const result = { platform: process.platform, passed: false, checks: [], startedAt: new Date().toISOString() };
  const check = label => { result.checks.push(label); console.log(`[pass] ${label}`); };
  let listener, connection;
  const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 90000 }).trim();
  const ps = script => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
  try {
    await db.query(`create table users(id uuid primary key);
      create table github_connections(id uuid primary key);
      create table audit_logs(id uuid primary key default gen_random_uuid(),user_id uuid references users(id),
        action text not null,resource text not null,details jsonb,created_at timestamptz default now())`);
    const userId = randomUUID();
    await db.query('insert into users(id) values($1)', [userId]);
    const server = await managed.addServer({ name: 'Disposable SSH lab', platform: process.platform }, userId);
    secrets.push(server.enrollmentToken);
    check('Server created in isolated Manager database');

    const tlsDir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'manager-ssh-tls-'));
    const key = path.join(tlsDir, 'key.pem'), cert = path.join(tlsDir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
      '-days', '1', '-subj', '/CN=Manager SSH lab', '-addext', 'subjectAltName=IP:127.0.0.1',
      '-addext', 'basicConstraints=critical,CA:TRUE'], { windowsHide: true, stdio: 'ignore' });
    const caPem = fs.readFileSync(cert, 'utf8');
    listener = https.createServer({ key: fs.readFileSync(key), cert: caPem }, async (req, res) => {
      try {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 800000) throw new Error('Body too large'); chunks.push(chunk); }
        const action = req.url.match(/^\/api\/server-agent\/(enroll|heartbeat|claim|report)$/)?.[1];
        if (!action || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
        const request = new Request(`https://127.0.0.1${req.url}`, { method: 'POST', headers: req.headers, body: Buffer.concat(chunks) });
        const response = await agentRoute.POST(request, { params: Promise.resolve({ action }) });
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
      } catch { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"Lab request failed"}'); }
    });
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const manager = `https://127.0.0.1:${listener.address().port}`;
    const observed = await ssh.probeSsh(target);
    assert.equal(observed.fingerprint, process.env.SSH_LAB_FINGERPRINT);
    check('Real OpenSSH identity matches independently read host key');
    await assert.rejects(ssh.connectSsh(target, process.env.SSH_LAB_PASSWORD, 'SHA256:' + 'A'.repeat(43)), /host key changed/);
    await assert.rejects(ssh.connectSsh(target, 'wrong-password', observed.fingerprint), /SSH connection failed/);
    check('Wrong host identity and wrong password rejected');

    console.log('[setup] Running the production SSH installer; official downloads may take several minutes.');
    const installed = await ssh.setupServerSsh(server.id, { ...target, password: process.env.SSH_LAB_PASSWORD,
      manager, caPem, fingerprint: observed.fingerprint, acceptFingerprint: true }, userId);
    fs.writeFileSync(path.join(root, 'ssh-lab-setup.log'), redact(installed.log, secrets));
    assert.equal(installed.online, true, installed.message);
    const detail = await managed.serverDetail(server.id);
    assert.equal(detail.server.status, 'online');
    assert.equal(detail.server.metrics.platform, process.platform);
    for (const tool of ['node', 'git', 'pm2', 'caddy']) assert.ok(detail.server.metrics.tools[tool], `${tool} missing from agent PATH`);
    assert.equal(detail.server.metrics.proxyError, null);
    check('SSH/SFTP installer completed and real agent reported healthy tools and metrics over verified HTTPS');
    result.tools = detail.server.metrics.tools;

    connection = await ssh.connectSsh(target, process.env.SSH_LAB_PASSWORD, observed.fingerprint);
    const left = await ssh.sshExec(connection, process.platform === 'win32'
      ? ssh.powershell("$ProgressPreference='SilentlyContinue'; Write-Output ('MANAGER_STAGE_COUNT=' + @(Get-ChildItem -LiteralPath $env:USERPROFILE -Directory -Filter 'manager-setup-*').Count)")
      : "printf 'MANAGER_STAGE_COUNT=%s\\n' \"$(find /tmp -maxdepth 1 -type d -name 'manager-setup-*' -user managersmoke | wc -l)\"");
    const count = left.match(/^MANAGER_STAGE_COUNT=(\d+)\r?$/m);
    assert.ok(count, 'SSH staging inspection did not return a count');
    assert.equal(Number(count[1]), 0, 'SSH staging directory leaked');
    connection.end(); connection = undefined;
    const agentRoot = process.platform === 'win32' ? path.join(process.env.ProgramData, 'ManagerAgent') : '/var/lib/manager-agent';
    const configuration = process.platform === 'win32' ? fs.readFileSync(path.join(agentRoot, 'agent.json'), 'utf8')
      : run('sudo', ['cat', path.join(agentRoot, 'agent.json')]);
    const saved = JSON.parse(configuration); secrets.push(saved.agentToken);
    assert.equal(saved.serverId, server.id); assert.equal(saved.enrolled, true);
    assert.ok(!configuration.includes(process.env.SSH_LAB_PASSWORD));
    const stored = (await db.query('select agent_hash,enrollment_hash from managed_servers where id=$1', [server.id])).rows[0];
    assert.equal(stored.enrollment_hash, null);
    assert.ok(stored.agent_hash && stored.agent_hash !== saved.agentToken);
    check('Enrollment is one-time, Manager stores a token hash, SSH password is absent and staging files are removed');

    let restarted;
    if (process.platform === 'win32') {
      const principal = ps("(Get-ScheduledTask -TaskName ManagerRemoteAgent).Principal.UserId");
      assert.ok(/S-1-5-19|LOCAL SERVICE/i.test(principal), `Unexpected agent principal: ${principal}`);
      ps("$ErrorActionPreference='Stop'; Stop-ScheduledTask -TaskName ManagerRemoteAgent; $until=(Get-Date).AddSeconds(30); do { $p=@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*ManagerAgent*manager-agent.cjs*run*' }); if(!$p.Count){break}; Start-Sleep 1 } while((Get-Date)-lt $until); if($p.Count){throw 'Agent did not stop with its task'}");
      restarted = Date.now();
      ps("Start-ScheduledTask -TaskName ManagerRemoteAgent");
    } else {
      assert.equal(run('systemctl', ['show', 'manager-agent', '--property=User', '--value']), 'manager-agent');
      assert.equal(run('systemctl', ['is-enabled', 'manager-agent']), 'enabled');
      run('sudo', ['systemctl', 'stop', 'manager-agent']);
      restarted = Date.now();
      run('sudo', ['systemctl', 'start', 'manager-agent']);
    }
    let refreshed;
    for (let n = 0; n < 30; n++) {
      refreshed = (await managed.serverDetail(server.id)).server;
      if (new Date(refreshed.last_seen_at).getTime() > restarted) break;
      await wait(2000);
    }
    assert.ok(new Date(refreshed.last_seen_at).getTime() > restarted, 'Heartbeat did not resume after service restart');
    check('Dedicated service identity and startup registration verified; monitoring resumes after a real service restart');
    const audit = JSON.stringify((await db.query('select action,details from audit_logs')).rows);
    for (const secret of secrets) assert.ok(!audit.includes(secret), 'Audit record leaked a credential');
    assert.ok(audit.includes('server.ssh.setup.finish'));
    check('Successful setup recorded without credentials in the audit log');
    result.passed = true;
  } catch (error) {
    result.error = redact(error.message, secrets);
    console.error(result.error);
    process.exitCode = 1;
  } finally {
    connection?.end();
    result.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(root, 'ssh-lab-result.json'), JSON.stringify(result, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### SSH onboarding — ${process.platform}\n\n${result.passed ? 'Passed' : 'Failed'}\n\n${result.checks.map(s => `- ${s}`).join('\n')}\n`);
    listener?.closeAllConnections();
    if (listener) await new Promise(resolve => listener.close(resolve));
    await db.end();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
