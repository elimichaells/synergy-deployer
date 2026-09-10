const assert = require('node:assert/strict');
const test = require('node:test');
const load = require('./server-module.cjs');

test('activation reports the exact running cron job without changing deployment phase', async () => {
  const calls = []; let released = 0;
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('from cron_jobs')) return { rows: [{ id: 'cron-one', name: 'Application schedule', last_started_at: '2026-09-01T00:00:00Z', timeout_seconds: 300 }] };
    return { rows: [] };
  }, release: () => released++ };
  const api = load('lib/deployment-activation.ts', { '@/lib/db': { db: { connect: async () => client } } });
  const blocking = await api.beginReleaseActivation('project', 'C:\\app', 'deployment');
  assert.equal(blocking.name, 'Application schedule');
  assert.ok(calls.some(call => call.sql === 'rollback'));
  assert.ok(!calls.some(call => call.sql.includes("set phase='activate'")));
  assert.equal(released, 1);
});

test('activation atomically changes phase when no cron job is running', async () => {
  const calls = [];
  const client = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; }, release() {} };
  const api = load('lib/deployment-activation.ts', { '@/lib/db': { db: { connect: async () => client } } });
  assert.equal(await api.beginReleaseActivation('project', 'C:\\app', 'deployment'), null);
  assert.ok(calls.some(call => call.sql.includes("set phase='activate'")));
  assert.ok(calls.some(call => call.sql === 'commit'));
});
