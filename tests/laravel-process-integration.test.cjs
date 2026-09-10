const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { runCommand } = require('../lib/exec.ts');
const { captureProjectProcesses, stopProjectProcesses } = require('../lib/deployment-processes.ts');
const { renameReleasePath } = require('../lib/deployment-filesystem.ts');

test('real Windows PHP/PM2: IPC shutdown, orphan cleanup, stable port and rename', {
  skip: process.platform !== 'win32' || !process.env.MANAGER_TEST_PHP, timeout: 90000,
}, async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-php-test-'));
  const root = path.join(base, 'live');
  const name = 'manager-php-fixture-' + randomUUID().slice(0, 8);
  const router = path.join(root, 'vendor/laravel/framework/src/Illuminate/Foundation/resources/server.php');
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const cli = async command => {
    const result = await runCommand(command, base, 30000, undefined, undefined, false);
    assert.equal(result.code, 0, 'Fixture PM2 operation failed');
    return result;
  };
  const body = async () => (await fetch('http://127.0.0.1:' + port, { signal: AbortSignal.timeout(2000) })).text();
  const waitReady = async () => { for (let i = 0; i < 40; i++) { try { if (await body() === 'php-fixture') return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); } assert.fail('Fixture PHP did not start'); };
  let orphan;
  try {
    await fs.mkdir(path.dirname(router), { recursive: true });
    await fs.writeFile(router, '<?php echo "php-fixture";');
    await fs.writeFile(path.join(base, 'fixture.config.json'), JSON.stringify({ apps: [{ name, script: path.resolve('scripts/pm2-runner.js'), cwd: root,
      shutdown_with_message: true, kill_timeout: 15000, env: { MANAGER_APP_CWD: root,
        MANAGER_START_CMD: `"${process.env.MANAGER_TEST_PHP}" -S 127.0.0.1:${port} "${router}"` } }] }));
    await cli(`pm2 start "${path.join(base, 'fixture.config.json')}" --only "${name}"`);
    await waitReady();
    const rows = JSON.parse((await cli('pm2 jlist')).output);
    const snapshot = await captureProjectProcesses(root, [rows.find(p => p.name === name).pid], true);
    assert.ok(snapshot.processes.length >= 3, 'Runner, shell and PHP must be captured');
    await cli(`pm2 delete "${name}"`);
    const after = await captureProjectProcesses(root, [], true);
    assert.equal(after.processes.length, 0, 'IPC shutdown must await PHP termination');
    await stopProjectProcesses(snapshot, () => {});

    // Simulate a PHP server left behind by an earlier runner, independent of PM2.
    orphan = spawn(process.env.MANAGER_TEST_PHP, ['-S', '127.0.0.1:' + port, router], { cwd: root, windowsHide: true, stdio: 'ignore' });
    const exited = new Promise(resolve => orphan.once('exit', resolve));
    await waitReady();
    const orphanSnapshot = await captureProjectProcesses(root, [], true);
    assert.ok(orphanSnapshot.processes.some(p => p.pid === orphan.pid));
    await stopProjectProcesses(orphanSnapshot, () => {});
    await exited;
    await assert.rejects(fetch('http://127.0.0.1:' + port, { signal: AbortSignal.timeout(1000) }));
    await renameReleasePath(root, path.join(base, 'previous'));
    await renameReleasePath(path.join(base, 'previous'), root);
  } finally {
    if (orphan && orphan.exitCode === null) orphan.kill();
    await runCommand(`pm2 delete "${name}"`, base, 30000, undefined, undefined, false);
    const snapshot = await captureProjectProcesses(root, [], true);
    await stopProjectProcesses(snapshot, () => {});
    assert.ok(base.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
});
