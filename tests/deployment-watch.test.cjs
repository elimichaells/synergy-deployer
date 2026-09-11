const assert = require('node:assert/strict');
const test = require('node:test');
const { watchDeployment } = require('../lib/deployment-watch.ts');
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
function timers(t) {
  const pending = new Map(); let next = 0;
  t.mock.method(global, 'setTimeout', (fn, ms) => { const id = ++next; pending.set(id, { fn, ms }); return id; });
  t.mock.method(global, 'clearTimeout', id => pending.delete(id));
  return {
    pending,
    async tick(ms) {
      const item = [...pending].find(([, value]) => value.ms === ms);
      assert.ok(item, 'Expected a ' + ms + 'ms timer');
      pending.delete(item[0]); item[1].fn(); await settle();
    },
  };
}

test('deployment polling retries a disconnected request and updates final log, branch, commit and finish time', async t => {
  const clock = timers(t); let requests = 0; let errors = 0; const updates = [];
  const final = { id: 'fixture', status: 'failed', log: 'Security gate blocked release', branch: 'dev', commit_sha: 'a'.repeat(40), finished_at: '2026-09-11T17:55:22Z' };
  t.mock.method(global, 'fetch', async (_url, options) => {
    assert.equal(options.cache, 'no-store'); requests++;
    if (requests === 1) throw new Error('connection closed');
    return Response.json(requests === 2 ? { id: 'fixture', status: 'running', log: 'Building' } : final);
  });
  watchDeployment('fixture', update => updates.push(update), () => errors++);
  await settle(); assert.equal(errors, 1);
  await clock.tick(5000); assert.equal(updates[0].status, 'running');
  await clock.tick(2000); assert.deepEqual(updates[1], final);
  assert.equal(clock.pending.size, 0); assert.equal(requests, 3);
});

test('closing details aborts the request and ignores a late response from a previous selection', async t => {
  const clock = timers(t); let resolveFetch, signal; const updates = [];
  t.mock.method(global, 'fetch', (_url, options) => { signal = options.signal; return new Promise(resolve => { resolveFetch = resolve; }); });
  const watcher = watchDeployment('old', update => updates.push(update));
  watcher.close(); assert.equal(signal.aborted, true);
  resolveFetch(Response.json({ id: 'old', status: 'running', log: 'late old log' }));
  await settle(); assert.deepEqual(updates, []); assert.equal(clock.pending.size, 0);
});

test('stalled detail requests time out and retry without overlapping requests', async t => {
  const clock = timers(t); let requests = 0; let errors = 0;
  t.mock.method(global, 'fetch', (_url, options) => { requests++; return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))); });
  const watcher = watchDeployment('fixture', () => {}, () => errors++);
  assert.equal(requests, 1); await clock.tick(10000);
  assert.equal(errors, 1); await clock.tick(5000); assert.equal(requests, 2);
  watcher.close(); await settle(); assert.equal(clock.pending.size, 0);
});
