const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { listWindowsProcesses } = require('../lib/deployment-processes.ts');
const { recoverProjectTerminalLocks, terminalCandidates } = require('../lib/deployment-terminals.ts');
const { renameReleasePath } = require('../lib/deployment-filesystem.ts');
const { inspectProjectDirectoryHandles } = require('../lib/deployment-locks.ts');

test('real Windows terminal lock: closes only the fixture holding the directory, then activates', {
  skip: process.platform !== 'win32', timeout: 60000,
}, async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-terminal-test-'));
  const root = path.join(base, 'live');
  const sibling = path.join(base, 'live-other');
  await fs.mkdir(root);
  await fs.mkdir(sibling);
  const shells = [];
  const openShell = async cwd => {
    const shell = spawn(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/d', '/q'], { cwd, windowsHide: true, stdio: 'pipe' });
    shells.push(shell);
    await new Promise((resolve, reject) => { shell.once('spawn', resolve); shell.once('error', reject); });
    // A spawned cmd.exe has not necessarily acquired its current-directory
    // handle yet. Wait for it to process a command before asserting the lock.
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Fixture shell did not become ready')), 5000);
      const ready = chunk => { if (chunk.toString().includes('MANAGER_FIXTURE_READY')) { clearTimeout(timeout); shell.stdout.off('data', ready); resolve(); } };
      shell.stdout.on('data', ready);
      shell.stdin.write('echo MANAGER_FIXTURE_READY\r\n');
    });
    return shell;
  };
  try {
    const locking = await openShell(root);
    const unrelated = await openShell(sibling);
    await fs.writeFile(path.join(root, 'keep.txt'), 'release data');
    await assert.rejects(fs.rename(root, path.join(base, 'previous')), error => ['EBUSY', 'EPERM', 'EACCES'].includes(error.code));
    // Same PID with a changed creation identity must never be killed.
    const rows = await listWindowsProcesses();
    const identity = rows.find(row => row.pid === locking.pid);
    assert.ok(identity);
    const owners = await inspectProjectDirectoryHandles(root);
    assert.ok(owners.owners.some(owner => owner.pid === locking.pid && owner.name.toLowerCase() === 'cmd.exe'));
    assert.ok(!owners.owners.some(owner => owner.pid === unrelated.pid), 'Sibling directory must not match the project prefix');
    assert.equal(locking.exitCode, null, 'Inspection must not stop processes');
    assert.ok(terminalCandidates(rows, process.pid).some(row => row.pid === locking.pid), 'Fixture must be an eligible shell');
    const inspected = await new Promise((resolve, reject) => {
      const script = `$ErrorActionPreference='Stop'; $r=[Console]::In.ReadToEnd()|ConvertFrom-Json; Add-Type -Path (Join-Path (Get-Location) 'scripts/DeploymentDirectoryHandles.cs'); $p=Get-Process -Id $r.pid; $h=$p.Handle; @{ holds=[DeploymentDirectoryHandles]::HoldsDirectory($h,[DeploymentDirectoryHandles]::ResolveRoot($r.root)); directories=[DeploymentDirectoryHandles]::OpenDirectories($h); root=[DeploymentDirectoryHandles]::ResolveRoot($r.root); created=$p.StartTime.ToUniversalTime().ToString('yyyyMMddHHmmssfff') } | ConvertTo-Json -Compress`;
      const helper = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 20000 }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout)));
      helper.stdin.end(JSON.stringify({ root, pid: locking.pid }));
    });
    assert.equal(inspected.holds, true, JSON.stringify(inspected));
    assert.equal(inspected.created, identity.created);
    const invalidResult = await new Promise((resolve, reject) => {
      const helper = execFile(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/close-deployment-terminals.ps1')],
        { windowsHide: true, timeout: 20000 }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout)));
      helper.stdin.end(JSON.stringify({ root, managerPid: process.pid, candidates: [{ ...identity, created: '20000101000000000' }] }));
    });
    assert.deepEqual(invalidResult.stopped, []);
    assert.equal(invalidResult.skipped[0].reason, 'changed-identity', JSON.stringify(invalidResult));
    assert.equal(locking.exitCode, null);
    const logs = [];
    await renameReleasePath(root, path.join(base, 'previous'), {
      sleep: async () => {}, recoverLock: () => recoverProjectTerminalLocks(root, line => { logs.push(line); }),
    }).catch(error => { throw new Error(logs.join(''), { cause: error }); });
    assert.ok(logs.some(line => line.includes('Closed dedicated terminals') && line.includes(String(locking.pid))), logs.join(''));
    assert.equal(unrelated.exitCode, null);
    assert.equal(await fs.readFile(path.join(base, 'previous', 'keep.txt'), 'utf8'), 'release data');
  } finally {
    await Promise.all(shells.map(shell => new Promise(resolve => {
      if (shell.exitCode !== null || shell.signalCode !== null) return resolve();
      shell.once('exit', resolve);
      shell.kill();
    })));
    // Only the uniquely created disposable fixture is removed.
    if (path.dirname(base) === os.tmpdir() && path.basename(base).startsWith('manager-terminal-test-')) await fs.rm(base, { recursive: true, force: true });
  }
});
