const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const load = require('./server-module.cjs');

async function setup(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-cleanup-service-'));
  t.after(async () => { assert.ok(base.startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(base, { recursive: true, force: true }); });
  const app = { id: randomUUID(), name: 'Test', root_path: path.join(base, 'live'), active_deployment_id: null };
  const root = path.join(base, '.manager-releases', app.id); await fs.mkdir(root, { recursive: true });
  let deleted = 0, plans = 0, processReads = 0, insertions = 0, destroyed = false;
  let resolveDone; const done = new Promise(resolve => { resolveDone = resolve; });
  const client = new EventEmitter();
  client.release = destroy => { destroyed = destroy; resolveDone(); };
  client.query = async sql => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: !(sql.includes('manager-project') ? options.busyApp : options.busySweep) }] };
    if (sql.includes(' as due ')) return { rows: [{ due: options.due !== false }] };
    if (sql.startsWith('insert into manager_release_cleanup_runs')) { insertions++; return { rows: [{ id: randomUUID() }] }; }
    if (sql.includes('from projects')) return { rows: [app] };
    if (sql.includes("status in ('queued','running')")) return { rows: options.running ? [{ id: 'active' }] : [] };
    if (sql.includes('from deployments')) return { rows: [] };
    return { rows: [] };
  };
  const query = async sql => ({ rows: sql.includes('select root_path from projects') ? [app] : [] });
  const entry = { path: path.join(root, randomUUID()), eligible: true, bytes: 100, name: 'old', kind: 'release' };
  const api = load('lib/release-cleanup.ts', {
    '@/lib/db': { db: { connect: async () => client }, query },
    '@/lib/api': { ApiError: class extends Error {} },
    '@/lib/exec': { runCommand: async () => { processReads++; return { code: options.pm2Failure ? 1 : 0, output: '[]' }; } },
    '@/lib/audit': { audit: async () => {} },
    '@/lib/update-maintenance': { maintenance: () => false, updateProtected: async (_name, work) => work() },
    '@/lib/release-retention': {
      RETENTION: {},
      planReleaseRetention: async () => {
        plans++; if (options.loseLock) client.emit('error', Error('connection lost'));
        return { projectId: app.id, projectName: app.name, root, warnings: [], entries: options.becameProtected && plans > 1 ? [{ ...entry, eligible: false }] : [entry] };
      },
      removeRetentionEntry: async () => { deleted++; return 100; },
    },
  });
  return { api, done, counters: () => ({ deleted, plans, processReads, insertions, destroyed }) };
}

test('a scan reports eligibility without removing files; cleanup rescans before deleting', async t => {
  const f = await setup(t); await f.api.startReleaseCleanup('scan', 'manual', 'admin'); await f.done;
  assert.equal(f.counters().deleted, 0); assert.equal(f.counters().plans, 1);
  const g = await setup(t); await g.api.startReleaseCleanup('clean', 'manual', 'admin'); await g.done;
  assert.equal(g.counters().deleted, 1); assert.equal(g.counters().plans, 2); assert.equal(g.counters().processReads, 2);
});

for (const options of [{ busyApp: true }, { running: true }, { pm2Failure: true }, { becameProtected: true }, { loseLock: true }]) {
  test('cleanup refuses unsafe state: ' + Object.keys(options)[0], async t => {
    const f = await setup(t, options); await f.api.startReleaseCleanup('clean', 'manual', 'admin'); await f.done;
    assert.equal(f.counters().deleted, 0);
    if (options.loseLock) assert.equal(f.counters().destroyed, true);
  });
}

for (const options of [{ busySweep: true }, { due: false }]) {
  test('scheduler avoids overlapping or premature runs: ' + Object.keys(options)[0], async t => {
    const f = await setup(t, options); assert.equal(await f.api.releaseCleanupTick(), null); await f.done;
    assert.equal(f.counters().insertions, 0); assert.equal(f.counters().deleted, 0);
  });
}
