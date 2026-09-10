const assert = require('node:assert/strict');
const test = require('node:test');
const load = require('./server-module.cjs');
class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }

test('project operation lock rejects concurrent work and releases pooled connections', async () => {
  let released = 0;
  const api = load('lib/project-operation.ts', { '@/lib/api': { ApiError }, '@/lib/db': { db: { connect: async () => ({ query: async () => ({ rows: [{ locked: false }] }), release: () => released++ }) } } });
  await assert.rejects(api.acquireProjectOperation('fixture'), error => error.status === 409);
  assert.equal(released, 1);
});

test('running deployments block console and repository preparation', async () => {
  const calls = []; let released = 0;
  const api = load('lib/project-operation.ts', { '@/lib/api': { ApiError }, '@/lib/db': { db: { connect: async () => ({ query: async sql => { calls.push(sql); return { rows: sql.includes('try_advisory') ? [{ locked: true }] : sql.includes('from deployments') ? [{ id: 'active' }] : [] }; }, release: () => released++ }) } } });
  await assert.rejects(api.acquireProjectOperation('fixture'), error => error.status === 409);
  assert.ok(calls.some(sql => sql.includes('pg_advisory_unlock'))); assert.equal(released, 1);
});

test('operation release is idempotent and does not leak an advisory lock', async () => {
  let unlocks = 0; let released = 0;
  const api = load('lib/project-operation.ts', { '@/lib/api': { ApiError }, '@/lib/db': { db: { connect: async () => ({ query: async sql => { if (sql.includes('pg_advisory_unlock')) unlocks++; return { rows: sql.includes('try_advisory') ? [{ locked: true }] : [] }; }, release: () => released++ }) } } });
  const release = await api.acquireProjectOperation('fixture'); await release(); await release();
  assert.equal(unlocks, 1); assert.equal(released, 1);
});

function setupModule(rows) {
  return load('lib/project-setup.ts', {
    '@/lib/api': { ApiError }, '@/lib/db': { query: async sql => ({ rows: sql.startsWith('select completed_at') ? rows : [] }) },
    '@/lib/github-connections': {}, '@/lib/deployment-preparation': {}, '@/lib/exec': {}, '@/lib/runtimes': {}, '@/lib/deployment-go': {}, '@/lib/project-setup-policy': {},
  });
}
test('draft applications cannot deploy before setup completion; legacy applications remain compatible', async () => {
  await assert.rejects(setupModule([{ completed_at: null }]).assertProjectSetupComplete('draft'), error => error.status === 409);
  await setupModule([]).assertProjectSetupComplete('legacy');
  await setupModule([{ completed_at: new Date() }]).assertProjectSetupComplete('ready');
});

test('manual domain registration never accesses Cloudflare and keeps the application port', async () => {
  let port; const queries = [];
  const api = load('lib/cloudflare.ts', {
    '@/lib/api': { ApiError }, '@/lib/secret-crypto': { decryptSecret: () => { throw new Error('Cloudflare access is forbidden in manual mode'); } },
    '@/lib/caddy': { updateCaddyStrict: async (_name, value) => { port = value; } },
    '@/lib/db': { query: async (sql, values) => { queries.push([sql, values]); return { rows: sql.startsWith('select name,port') ? [{ name: 'Fixture', port: 3117 }] : sql.includes('returning id') ? [{ id: 'domain' }] : [] }; } },
  });
  await api.createProjectDomain('fixture', { mode: 'manual', hostname: 'app.example.com', recordType: 'A', recordContent: '203.0.113.10', isPrimary: true });
  assert.equal(port, 3117); assert.ok(queries.some(([sql]) => sql.includes("'manual','pending'")));
  assert.ok(!queries.some(([sql]) => sql.trimStart().startsWith('select') && sql.includes('token_ciphertext')));
});

test('domain ownership conflicts fail before Caddy is changed', async () => {
  let writes = 0;
  const api = load('lib/cloudflare.ts', {
    '@/lib/api': { ApiError }, '@/lib/secret-crypto': {}, '@/lib/caddy': { updateCaddyStrict: async () => writes++ },
    '@/lib/db': { query: async sql => ({ rows: sql.startsWith('select name,port') ? [{ name: 'Fixture', port: 3117 }] : sql.includes('union all') ? [{ id: 'other' }] : [] }) },
  });
  await assert.rejects(api.createProjectDomain('fixture', { mode: 'manual', hostname: 'taken.example.com' }), error => error.status === 409);
  assert.equal(writes, 0);
});

test('an unmanaged Cloudflare record is never overwritten', async t => {
  const requests = []; let caddyWrites = 0;
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url, init) => { requests.push({ url, method: init?.method || 'GET' }); return Response.json({ success: true, result: url.includes('/dns_records') ? [{ id: 'unmanaged-record' }] : [{ id: 'zone', name: 'example.com' }] }); };
  const api = load('lib/cloudflare.ts', {
    '@/lib/api': { ApiError }, '@/lib/secret-crypto': { decryptSecret: () => 'fixture-token' }, '@/lib/caddy': { updateCaddyStrict: async () => caddyWrites++ },
    '@/lib/db': { query: async sql => ({ rows: sql.startsWith('select name,port') ? [{ name: 'Fixture', port: 3117 }] : sql.includes('select cc.*') ? [{ id: 'connection', token_ciphertext: 'fixture' }] : [] }) },
  });
  await assert.rejects(api.createProjectDomain('fixture', { hostname: 'taken.example.com', recordType: 'A', recordContent: '203.0.113.10', cloudflareConnectionId: 'connection' }), error => error.status === 409);
  assert.equal(caddyWrites, 0); assert.ok(requests.every(request => request.method === 'GET'));
});

test('viewer role cannot execute console commands or mutate setup', async () => {
  const common = {
    '@/lib/auth': { getSessionFromCookie: async () => ({ role: 'viewer' }) },
    '@/lib/rbac': { requireRole: (user, allowed) => { if (!allowed.includes(user.role)) throw new ApiError('Forbidden', 403); } },
    '@/lib/api': { ApiError, jsonError: error => Response.json({ error: error.message }, { status: error.status || 500 }) },
    '@/lib/db': { query: () => { throw new Error('Database access forbidden'); } },
    '@/lib/project-operation': {},
  };
  const consoleApi = load('app/api/sites/[id]/console/route.ts', { ...common, '@/lib/exec': {}, '@/lib/project-console': {}, '@/lib/runtimes': {}, '@/lib/project-databases': {}, '@/lib/data-services': {} });
  const setupApi = load('app/api/sites/[id]/setup/route.ts', { ...common, '@/lib/project-setup': {}, '@/lib/project-setup-policy': {} });
  for (const api of [consoleApi, setupApi]) {
    const response = await api.POST(new Request('http://localhost/api/test', { method: 'POST', body: '{}' }), { params: Promise.resolve({ id: 'fixture' }) });
    assert.equal(response.status, 403);
  }
});
