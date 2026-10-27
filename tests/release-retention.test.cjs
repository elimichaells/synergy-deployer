const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { planReleaseRetention, removeRetentionEntry, treeBytes } = require('../lib/release-retention.ts');
const load = require('./server-module.cjs');
const DAY = 86400000;

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-retention-test-'));
  t.after(async () => { assert.ok(base.startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(base, { recursive: true, force: true, maxRetries: 3 }); });
  const app = { id: randomUUID(), name: 'Retention fixture', root_path: path.join(base, 'live'), active_deployment_id: null };
  const root = path.join(base, '.manager-releases', app.id);
  await fs.mkdir(app.root_path); await fs.writeFile(path.join(app.root_path, 'uploads.txt'), 'live data');
  const deployments = [];
  async function release(days, status = 'success', phase = status === 'success' ? 'complete' : 'building', overrides = {}) {
    const id = randomUUID(), folder = path.join(root, id);
    await fs.mkdir(path.join(folder, 'candidate'), { recursive: true });
    await fs.writeFile(path.join(folder, 'candidate', 'build.bin'), Buffer.alloc(100));
    const journal = { version: 2, projectId: app.id, deploymentId: id, root: app.root_path, candidate: path.join(folder, 'candidate'), previous: path.join(folder, 'previous'), phase, activationMode: 'contents', originalMoved: false, candidateMoved: false, moved: [], contentMoves: [], ...overrides };
    await fs.writeFile(path.join(folder, 'release.json'), JSON.stringify(journal));
    const row = { id, status, phase, finished_at: new Date(Date.now() - days * DAY), release_path: folder };
    deployments.push(row); return { id, folder, row, journal };
  }
  return { base, app, root, deployments, release, plan: (refs = [], measure = true) => planReleaseRetention(app, deployments, refs, Date.now(), () => {}, measure) };
}

test('retains current deployment plus three newest successes, and honors minimum age', async t => {
  const f = await fixture(t);
  const active = await f.release(60); f.app.active_deployment_id = active.id;
  const expired = await f.release(40);
  const kept = [await f.release(30), await f.release(20), await f.release(10)];
  const plan = await f.plan();
  assert.deepEqual(plan.entries.filter(e => e.eligible).map(e => e.name), [expired.id]);
  assert.ok(plan.entries.find(e => e.name === active.id).reason.includes('Current'));
  for (const r of kept) assert.ok(!plan.entries.find(e => e.name === r.id).eligible);
  await removeRetentionEntry(plan, plan.entries.find(e => e.name === expired.id));
  await assert.rejects(fs.stat(expired.folder), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.app.root_path, 'uploads.txt'), 'utf8'), 'live data');
  const recent = await f.release(1, 'failed');
  assert.equal((await f.plan()).entries.find(e => e.name === recent.id).eligible, false);
});

test('terminal failed candidates expire, but active or unsafe recovery states never do', async t => {
  const f = await fixture(t);
  const removable = await f.release(10, 'failed');
  const inUse = await f.release(10, 'failed');
  const notFinished = await f.release(10, 'running');
  const moved = await f.release(10, 'failed', 'building', { originalMoved: true });
  const incompleteRollback = await f.release(10, 'failed', 'rolled-back', { contentMoves: [{ state: 'pending' }] });
  const rolledBack = await f.release(10, 'failed', 'rolled-back', { contentMoves: [{ state: 'reverted' }] });
  const pinned = await f.release(10, 'failed'); await fs.writeFile(path.join(pinned.folder, '.keep'), 'keep');
  const plan = await f.plan([path.join(inUse.folder, 'candidate', 'index.js')]);
  assert.deepEqual(new Set(plan.entries.filter(e => e.eligible).map(e => e.name)), new Set([removable.id, rolledBack.id]));
  for (const r of [inUse, notFinished, moved, incompleteRollback, pinned]) assert.equal(plan.entries.find(e => e.name === r.id).eligible, false);
  await f.release(20, 'failed', 'restoring');
  const interrupted = await f.plan();
  assert.equal(interrupted.entries.length, 0); assert.match(interrupted.warnings.join(' '), /recovery/);
});

test('unknown, mismatched, missing and future-dated records are preserved', async t => {
  const f = await fixture(t);
  const wrong = await f.release(20, 'failed', 'building', { projectId: randomUUID() });
  const missing = await f.release(20, 'failed'); await fs.unlink(path.join(missing.folder, 'release.json'));
  const future = await f.release(-1, 'failed');
  const wrongRoot = await f.release(20, 'failed', 'building', { root: f.base });
  const unknown = await f.release(20, 'failed'); f.deployments.splice(f.deployments.findIndex(d => d.id === unknown.id), 1);
  const oldVersion = await f.release(20, 'failed', 'building', { version: 1 });
  const plan = await f.plan();
  for (const r of [wrong, missing, future, wrongRoot, unknown, oldVersion]) assert.equal(plan.entries.find(e => e.name === r.id).eligible, false);
});

test('nested junctions are removed as links without touching their external data', async t => {
  const f = await fixture(t); const old = await f.release(20, 'failed');
  const outside = path.join(f.base, 'database-backup'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'important.sql'), 'keep me');
  await fs.symlink(outside, path.join(old.folder, 'candidate', 'linked-data'), process.platform === 'win32' ? 'junction' : 'dir');
  const plan = await f.plan();
  await removeRetentionEntry(plan, plan.entries[0]);
  assert.equal(await fs.readFile(path.join(outside, 'important.sql'), 'utf8'), 'keep me');
});

test('linked release roots and forged outside deletion targets are rejected', async t => {
  const f = await fixture(t); const old = await f.release(20, 'failed');
  const plan = await f.plan();
  await assert.rejects(removeRetentionEntry(plan, { ...plan.entries[0], path: f.app.root_path }), /Invalid cleanup target/);
  const moved = path.join(f.base, 'outside'); await fs.rename(f.root, moved);
  await fs.symlink(moved, f.root, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.plan(), /link/);
  await assert.rejects(removeRetentionEntry(plan, plan.entries[0]), /link/);
  assert.ok(await fs.stat(path.join(moved, old.id, 'candidate', 'build.bin')));
});

test('lost ownership cancels deletion and preserves the release journal', async t => {
  const f = await fixture(t); const old = await f.release(20, 'failed'); const plan = await f.plan();
  await assert.rejects(removeRetentionEntry(plan, plan.entries[0], () => { throw Error('lock lost'); }), /lock lost/);
  assert.ok(await fs.stat(path.join(old.folder, 'release.json')));
});

test('dependency caches expire conservatively and the newest snapshot is retained', async t => {
  const f = await fixture(t); await f.release(20);
  const caches = path.join(f.root, 'dependencies'); await fs.mkdir(caches);
  for (const [name, days] of [['a'.repeat(64), 10], ['b'.repeat(64), 1], ['.pending-' + randomUUID(), 10], ['unknown', 100]]) {
    const folder = path.join(caches, name); await fs.mkdir(folder); await fs.writeFile(path.join(folder, 'cache'), 'abc');
    await fs.utimes(folder, new Date(Date.now() - days * DAY), new Date(Date.now() - days * DAY));
  }
  const plan = await f.plan(); const cachesPlan = plan.entries.filter(e => e.kind === 'cache');
  assert.equal(cachesPlan.filter(e => e.eligible).length, 2);
  assert.equal(cachesPlan.find(e => e.name === 'b'.repeat(64)).eligible, false);
  assert.equal(cachesPlan.find(e => e.name === 'unknown').eligible, false);
  assert.ok(await treeBytes(f.root) > 0);
});

test('process-reference inspection fails closed and includes stopped-process paths and runner environment', () => {
  const api = load('lib/release-cleanup.ts', { '@/lib/db': {}, '@/lib/api': {}, '@/lib/exec': {}, '@/lib/audit': {}, '@/lib/update-maintenance': {}, '@/lib/release-retention': {} });
  assert.throws(() => api.processReferences(null), /unavailable/);
  assert.throws(() => api.processReferences([{ name: 'app' }]), /unavailable/);
  const refs = api.processReferences([{ name: 'app', pm2_env: { status: 'stopped', pm_cwd: '/old/previous', env: { MANAGER_APP_CWD: '/old/candidate' }, args: ['--config', '/old/config.json'] } }]);
  assert.ok(refs.includes('/old/previous')); assert.ok(refs.includes('/old/candidate')); assert.ok(refs.includes('/old/config.json'));
});

test('cleanup endpoint rejects viewer/operator writes and never accepts filesystem paths from requests', async () => {
  let calls = 0;
  const api = load('app/api/system/release-cleanup/route.ts', {
    'next/server': { NextResponse: { json: body => body } },
    '@/lib/auth': { getSessionFromCookie: async () => ({ id: 'viewer', role: 'viewer' }) },
    '@/lib/rbac': { requireRole: (user, roles) => { if (!roles.includes(user.role)) throw Error('Forbidden'); } },
    '@/lib/api': { jsonError: e => ({ error: e.message }) },
    '@/lib/request-body': { requireSameOrigin: () => { calls++; }, readBody: () => { calls++; } },
    '@/lib/release-cleanup': { startReleaseCleanup: () => { calls++; }, setCleanupEnabled: () => { calls++; } },
  });
  assert.deepEqual(await api.POST(new Request('https://manager.test/api/system/release-cleanup', { method: 'POST' })), { error: 'Forbidden' });
  assert.equal(calls, 0);
});
