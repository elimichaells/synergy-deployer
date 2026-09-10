const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const os = require('node:os');
const load = require('./server-module.cjs');
class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
const id1 = '11111111-1111-4111-8111-111111111111';
const id2 = '22222222-2222-4222-8222-222222222222';
const groupId = '33333333-3333-4333-8333-333333333333';
const groupApi = () => load('lib/application-groups.ts', { '@/lib/api': { ApiError }, '@/lib/db': {} });

test('linking different technologies groups both environment families without altering deployment configuration', async () => {
  const writes = [];
  const client = { query: async (sql, values) => {
    if (sql.startsWith('select id,name')) return { rows: [
      { id: id1, name: 'Portal', environment: 'production', component_role: 'frontend', application_group_id: null },
      { id: id2, name: 'API', environment: 'production', component_role: 'backend', application_group_id: null },
    ] };
    writes.push({ sql, values }); return { rows: sql.startsWith('insert into application_groups') ? [{ id: groupId }] : [] };
  } };
  assert.equal(await groupApi().linkApplicationProjects(client, id1, id2, 'frontend', 'backend'), groupId);
  const updates = writes.filter(row => row.sql.startsWith('update projects'));
  assert.equal(updates.length, 2);
  assert.ok(updates.every(row => row.sql.includes('or production_id=$3')));
  assert.deepEqual(updates.map(row => row.values), [[groupId, 'frontend', id1], [groupId, 'backend', id2]]);
  assert.ok(writes.every(row => !/database|port|runtime|auto_deploy|repo_url/.test(row.sql)));
});

test('group linking rejects self-links, invalid roles, staging roots and implicit group merges', async () => {
  const api = groupApi();
  await assert.rejects(api.linkApplicationProjects({}, id1, id1, 'frontend'), error => error.status === 400);
  assert.throws(() => api.componentRole('arbitrary'), error => error.status === 400);
  for (const staging of [true, false]) {
    const client = { query: async () => ({ rows: [
      { id: id1, environment: staging ? 'staging' : 'production', application_group_id: 'one' },
      { id: id2, environment: 'production', application_group_id: 'two' },
    ] }) };
    await assert.rejects(api.linkApplicationProjects(client, id1, id2, 'frontend'), error => error.status === (staging ? 400 : 409));
  }
});

async function createProject(body, role = 'admin') {
  const calls = []; let portOptions;
  const query = async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; };
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('insert into projects')) return { rows: [{ id: sql.includes("'production'") ? id1 : id2, name: values[0], port: 3217, url: null }] };
    return { rows: [] };
  }, release() {} };
  const api = load('app/api/sites/route.ts', {
    '@/lib/db': { query, db: { connect: async () => client } }, '@/lib/auth': { getSessionFromCookie: async () => ({ id: id1, role }) },
    '@/lib/rbac': { requireRole: (_user, allowed) => { if (!allowed.includes(role)) throw new ApiError('Forbidden', 403); } },
    '@/lib/api': { jsonError: error => Response.json({ error: error.message }, { status: error.status || 500 }) },
    '@/lib/settings': { getSetting: async key => path.join(os.tmpdir(), key) },
    '@/lib/ports': { allocateProjectPorts: async (...args) => { portOptions = args; return { port: 3217, stagingPort: 4217 }; } },
    '@/lib/project-setup': { ensureProjectSetupSchema: async () => {} },
    '@/lib/project-pins': { ensureProjectPinsSchema: async () => {} },
    '@/lib/project-setup-policy': { validateSetupRepository() {} }, '@/lib/project-types': { PROJECT_TYPES: { next: {} } },
    '@/lib/application-groups': { ensureApplicationGroupsSchema: async () => {}, componentRole: groupApi().componentRole, projectIdentifier: groupApi().projectIdentifier,
      linkApplicationProjects: async (...args) => { calls.push({ link: args.slice(1) }); } },
  });
  const response = await api.POST(new Request('http://localhost/api/sites', { method: 'POST', body: JSON.stringify({ name: 'Fixture', repoUrl: 'https://github.com/example/fixture', projectType: 'next', defaultBranch: 'main', setupDraft: true, ...body }) }));
  return { response, calls, portOptions };
}

test('new-application setup requires an explicit environment choice', async () => {
  const result = await createProject({});
  assert.equal(result.response.status, 400);
  assert.ok(!result.calls.some(call => call.sql?.includes('insert into projects')));
});
test('production-only creation does not allocate or create staging', async () => {
  const result = await createProject({ createStaging: false });
  assert.equal(result.response.status, 201);
  assert.equal(result.portOptions[2], false);
  assert.equal(result.calls.filter(call => call.sql?.includes('insert into projects')).length, 1);
});
test('optional staging uses its own branch, port, and setup state in the same transaction', async () => {
  const result = await createProject({ createStaging: true, stagingBranch: 'develop' });
  assert.equal(result.response.status, 201);
  assert.equal(result.portOptions[2], true);
  const inserts = result.calls.filter(call => call.sql?.includes('insert into projects'));
  assert.equal(inserts.length, 2); assert.equal(inserts[0].values[3], 'main'); assert.equal(inserts[1].values[3], 'develop');
  assert.equal(inserts[1].values[11], 4217);
  assert.equal(result.calls.filter(call => call.sql?.includes('insert into project_setup')).length, 2);
  assert.ok(result.calls.some(call => call.sql === 'commit'));
});
test('creation can atomically join a related application and viewers cannot create applications', async () => {
  const linked = await createProject({ createStaging: false, relatedProjectId: id2, componentRole: 'frontend' });
  assert.equal(linked.response.status, 201);
  assert.deepEqual(linked.calls.find(call => call.link).link, [id1, id2, 'frontend']);
  const viewer = await createProject({ createStaging: false }, 'viewer');
  assert.equal(viewer.response.status, 403); assert.equal(viewer.calls.length, 0);
});

test('related application endpoints prohibit viewer mutations before querying the database', async () => {
  const api = load('app/api/sites/[id]/related/route.ts', {
    '@/lib/auth': { getSessionFromCookie: async () => ({ role: 'viewer' }) },
    '@/lib/rbac': { requireRole: (_user, allowed) => { if (!allowed.includes('viewer')) throw new ApiError('Forbidden', 403); } },
    '@/lib/api': { jsonError: error => Response.json({ error: error.message }, { status: error.status || 500 }) },
    '@/lib/application-groups': { updateApplicationGroup: async () => assert.fail('Mutation should not run') },
  });
  for (const method of ['POST', 'DELETE']) {
    const result = await api[method](new Request('http://localhost', { method, ...(method === 'POST' ? { body: '{}' } : {}) }), { params: Promise.resolve({ id: id1 }) });
    assert.equal(result.status, 403);
  }
});
