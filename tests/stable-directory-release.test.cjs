const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DeploymentRelease } = require('../lib/deployment-release.ts');

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-stable-release-'));
  const children = [];
  t.after(async () => {
    await Promise.all(children.map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', resolve); child.kill();
    })));
    assert.equal(path.dirname(base), os.tmpdir());
    assert.ok(path.basename(base).startsWith('manager-stable-release-'));
    await fs.rm(base, { recursive: true, force: true });
  });
  const root = path.join(base, 'live');
  for (const directory of ['.git', 'storage/app/private/crypto', 'public/uploads', 'database/migrations', 'node_modules']) await fs.mkdir(path.join(root, directory), { recursive: true });
  for (const [file, value] of Object.entries({ '.git/HEAD': 'old head', 'index.js': 'old code', 'public/app.js': 'old asset', 'database/migrations/old.sql': 'old migration', 'node_modules/module.js': 'old dependency', '.env': 'fixture-private-setting', 'database/database.sqlite': 'existing database', 'storage/app/private/crypto/key.txt': 'existing key', 'public/uploads/upload.txt': 'existing upload' })) await fs.writeFile(path.join(root, file), value);
  const release = new DeploymentRelease(root, 'fixture-project', 'fixture-deployment', { activationMode: 'contents' });
  const execute = async command => ({ code: 0, output: command === 'git ls-files -z' ? 'index.js\0public/app.js\0database/migrations/old.sql\0' : command.includes('--ignored') ? '.env\0storage/\0public/uploads/\0database/database.sqlite\0node_modules/\0' : '' });
  await release.prepare(execute);
  for (const [file, value] of Object.entries({ 'index.js': 'new code', 'public/app.js': 'new asset', 'database/migrations/new.sql': 'new migration', 'node_modules/module.js': 'new dependency' })) {
    await fs.mkdir(path.dirname(path.join(release.candidate, file)), { recursive: true });
    await fs.writeFile(path.join(release.candidate, file), value);
  }
  await fs.unlink(path.join(release.candidate, 'database/migrations/old.sql'));
  const start = async (command, args, cwd) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: 'pipe' });
    children.push(child);
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    return child;
  };
  return { root, release, base, start, execute };
}

test('stable activation preserves root, nested persistent directories, env and data identities across rollback', async t => {
  const { root, release } = await fixture(t);
  const retained = ['', 'storage', 'storage/app/private/crypto', 'public', 'public/uploads', 'database', 'database/database.sqlite', '.env'];
  const before = await Promise.all(retained.map(file => fs.stat(path.join(root, file), { bigint: true })));
  await fs.writeFile(path.join(root, 'storage/during-build.txt'), 'written during build');
  await release.activate();
  assert.equal(await fs.readFile(path.join(root, 'index.js'), 'utf8'), 'new code');
  assert.equal(await fs.readFile(path.join(root, 'public/app.js'), 'utf8'), 'new asset');
  assert.equal(await fs.readFile(path.join(root, 'node_modules/module.js'), 'utf8'), 'new dependency');
  await assert.rejects(fs.stat(path.join(root, 'database/migrations/old.sql')));
  await fs.writeFile(path.join(root, 'storage/after-start.txt'), 'written before failed health');
  await release.rollback();
  for (const [index, file] of retained.entries()) assert.equal((await fs.stat(path.join(root, file), { bigint: true })).ino, before[index].ino, file + ' identity must stay unchanged');
  for (const [file, value] of Object.entries({ 'index.js': 'old code', 'public/app.js': 'old asset', 'node_modules/module.js': 'old dependency', '.env': 'fixture-private-setting', 'database/database.sqlite': 'existing database', 'storage/during-build.txt': 'written during build', 'storage/after-start.txt': 'written before failed health' })) assert.equal(await fs.readFile(path.join(root, file), 'utf8'), value);
  assert.equal(await fs.readFile(path.join(release.candidate, 'index.js'), 'utf8'), 'new code');
  const journal = JSON.parse(await fs.readFile(path.join(release.base, 'release.json'), 'utf8'));
  assert.equal(journal.phase, 'rolled-back');
  assert.ok(journal.contentMoves.length > 0 && journal.contentMoves.every(move => move.state === 'reverted'));
});

test('Windows activation and rollback work while shells hold both the live root and persistent storage open', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const { root, release, start, base } = await fixture(t);
  const shell = path.join(process.env.SystemRoot, 'System32', 'cmd.exe');
  const rootShell = await start(shell, ['/d', '/q'], root);
  const storageShell = await start(shell, ['/d', '/q'], path.join(root, 'storage/app/private/crypto'));
  // The spawn event only means the process exists. Wait until cmd has entered
  // its working directory before asserting that it holds a directory handle.
  await Promise.all([rootShell, storageShell].map(child => new Promise((resolve, reject) => {
    let output = '';
    const onData = chunk => {
      output += chunk.toString();
      if (output.includes('fixture-directory-ready')) {
        child.stdout.off('data', onData); child.off('exit', onExit); resolve();
      }
    };
    const onExit = () => reject(new Error('Shell fixture exited before acquiring its working directory'));
    child.stdout.on('data', onData); child.once('exit', onExit);
    child.stdin.write('echo fixture-directory-ready\r\n');
  })));
  await assert.rejects(fs.rename(root, path.join(base, 'whole-directory-move')), error => ['EBUSY', 'EPERM', 'EACCES'].includes(error.code));
  await release.activate(() => assert.fail('Stable activation must not close terminals'));
  assert.equal(await fs.readFile(path.join(root, 'index.js'), 'utf8'), 'new code');
  await release.rollback();
  assert.equal(await fs.readFile(path.join(root, 'index.js'), 'utf8'), 'old code');
  assert.equal(rootShell.exitCode, null);
  assert.equal(storageShell.exitCode, null);
});

test('Windows file lock during partial activation restores completed moves without touching persistent data', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const { root, release, start } = await fixture(t);
  const script = `$ErrorActionPreference='Stop'; $request=[Console]::In.ReadLine()|ConvertFrom-Json; $file=[IO.File]::Open($request.file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); try { [Console]::Out.WriteLine('ready'); [Console]::In.ReadLine() | Out-Null } finally { $file.Dispose() }`;
  const blocker = await start('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], path.dirname(root));
  const ready = new Promise((resolve, reject) => { blocker.stdout.once('data', chunk => chunk.toString().includes('ready') ? resolve() : reject(new Error('Fixture not ready'))); blocker.once('exit', () => reject(new Error('Fixture exited before ready'))); });
  blocker.stdin.write(JSON.stringify({ file: path.join(root, 'index.js') }) + '\n');
  await ready;
  await assert.rejects(release.activate(), /locked|inaccessible/);
  const pending = JSON.parse(await fs.readFile(path.join(release.base, 'release.json'), 'utf8'));
  assert.ok(pending.contentMoves.some(move => move.state === 'done'));
  assert.ok(pending.contentMoves.some(move => move.state === 'pending' && move.path === 'index.js'));
  await release.rollback();
  assert.equal(await fs.readFile(path.join(root, 'index.js'), 'utf8'), 'old code');
  assert.equal(await fs.readFile(path.join(root, '.git/HEAD'), 'utf8'), 'old head');
  assert.equal(await fs.readFile(path.join(root, 'public/uploads/upload.txt'), 'utf8'), 'existing upload');
  assert.equal(await fs.readFile(path.join(release.candidate, 'index.js'), 'utf8'), 'new code');
});

test('stable activation rejects a linked ancestor of persistent data before moving source', async t => {
  const { root, release, base } = await fixture(t);
  const destination = path.join(base, 'external');
  await fs.mkdir(destination);
  await fs.writeFile(path.join(destination, 'keep.txt'), 'untouched');
  const publicPath = path.join(release.candidate, 'public');
  assert.ok(publicPath.startsWith(release.candidate + path.sep));
  await fs.rm(publicPath, { recursive: true, force: true });
  await fs.symlink(destination, publicPath, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(release.activate(), /link|ancestor/);
  assert.equal(await fs.readFile(path.join(root, 'index.js'), 'utf8'), 'old code');
  assert.equal(await fs.readFile(path.join(destination, 'keep.txt'), 'utf8'), 'untouched');
});

test('stable activation creates a new project and keeps its failed candidate data when rolling back', async t => {
  const { base } = await fixture(t);
  const root = path.join(base, 'new-project');
  const release = new DeploymentRelease(root, 'new-project', 'new-deployment', { activationMode: 'contents' });
  await release.prepare(async () => ({ code: 0, output: '' }));
  await fs.mkdir(path.join(release.candidate, '.git'), { recursive: true });
  await fs.mkdir(path.join(release.candidate, 'storage'));
  await fs.writeFile(path.join(release.candidate, 'index.js'), 'new app');
  await fs.writeFile(path.join(release.candidate, '.env'), 'new configuration');
  await release.activate();
  assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), 'new configuration');
  await fs.writeFile(path.join(root, 'storage/runtime.txt'), 'keep this runtime data');
  await release.rollback();
  await assert.rejects(fs.stat(root), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(release.candidate, 'storage/runtime.txt'), 'utf8'), 'keep this runtime data');
});
