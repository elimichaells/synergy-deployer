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

test('group linking rejects self-links, invalid roles, paired staging roots and implicit group merges', async () => {
  const api = groupApi();
  await assert.rejects(api.linkApplicationProjects({}, id1, id1, 'frontend'), error => error.status === 400);
  assert.throws(() => api.componentRole('arbitrary'), error => error.status === 400);
  for (const staging of [true, false]) {
    const client = { query: async sql => sql.includes('count(*)') ? { rows: [{ count: 1 }] } : { rows: [
      { id: id1, environment: staging ? 'staging' : 'production', production_id: staging ? id2 : null, application_group_id: 'one' },
      { id: id2, environment: 'production', application_group_id: 'two' },
    ] } };
    await assert.rejects(api.linkApplicationProjects(client, id1, id2, 'frontend'), error => error.status === (staging ? 400 : 409));
  }
});

test('an application alone in its project moves into another project and leaves no empty project behind', async () => {
  const writes = [];
  const client = { query: async (sql, values) => {
    if (sql.startsWith('select id,name')) return { rows: [
      { id: id1, name: 'API', environment: 'production', component_role: 'application', application_group_id: 'solo' },
      { id: id2, name: 'Portal', environment: 'production', component_role: 'frontend', application_group_id: groupId },
    ] };
    if (sql.includes('count(*)')) return { rows: [{ count: 0 }] };
    writes.push({ sql, values }); return { rows: [] };
  } };
  assert.equal(await groupApi().linkApplicationProjects(client, id1, id2, 'backend'), groupId);
  assert.deepEqual(writes.filter(row => row.sql.startsWith('update projects')).map(row => row.values[0]), [groupId, groupId]);
  assert.ok(writes.some(row => row.sql.startsWith('delete from application_groups') && row.values[0] === 'solo'));
});

async function createProject(body, role = 'admin') {
  const calls = []; let portOptions;
  const query = async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; };
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('insert into projects')) {
      const paired = sql.includes("'staging'");
      return { rows: [{ id: paired ? id2 : id1, name: values[0], port: values[11], url: null,
        environment: paired ? 'staging' : values[15], production_id: paired ? values[14] : null, default_branch: values[3], root_path: values[5], auto_deploy: false }] };
    }
    return { rows: [] };
  }, release() {} };
  const api = load('app/api/sites/route.ts', {
    '@/lib/github-connections': { getGitConnection: async () => ({provider:'github',base_url:'https://github.com'}) },
    '@/lib/git-provider-policy': require('../lib/git-provider-policy.ts'),
    '@/lib/db': { query, db: { connect: async () => client } }, '@/lib/auth': { getSessionFromCookie: async () => ({ id: id1, role }) },
    '@/lib/rbac': { requireRole: (_user, allowed) => { if (!allowed.includes(role)) throw new ApiError('Forbidden', 403); } },
    '@/lib/api': { ApiError, jsonError: error => Response.json({ error: error.message }, { status: error.status || 500 }) },
    '@/lib/settings': { getSetting: async key => path.join(os.tmpdir(), key) },
    '@/lib/ports': { allocateProjectPorts: async (...args) => { portOptions = args; return { port: 3217, stagingPort: 4217 }; } },
    '@/lib/application-environments': require('../lib/application-environments.ts'),
    '@/lib/project-setup': { ensureProjectSetupSchema: async () => {} },
    '@/lib/project-pins': { ensureProjectPinsSchema: async () => {} },
    '@/lib/project-setup-policy': { validateSetupRepository() {} }, '@/lib/project-types': { PROJECT_TYPES: { next: {} } },
    '@/lib/application-groups': { ensureApplicationGroupsSchema: async () => {}, componentRole: groupApi().componentRole, projectIdentifier: groupApi().projectIdentifier,
      linkApplicationProjects: async (...args) => { calls.push({ link: args.slice(1) }); },
      assignOwnProject: async (...args) => { calls.push({ own: args.slice(1) }); } },
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
  assert.ok(!linked.calls.some(call => call.own), 'joining a project must not also create one');
  const standalone = await createProject({ createStaging: false });
  assert.equal(standalone.calls.find(call => call.own).own[0], id1, 'a standalone app starts its own project');
  const viewer = await createProject({ createStaging: false }, 'viewer');
  assert.equal(viewer.response.status, 403); assert.equal(viewer.calls.length, 0);
});

test('related application endpoints prohibit viewer mutations before querying the database', async () => {
  const api = load('app/api/sites/[id]/related/route.ts', {
    '@/lib/auth': { getSessionFromCookie: async () => ({ role: 'viewer' }) },
    '@/lib/rbac': { requireRole: (_user, allowed) => { if (!allowed.includes('viewer')) throw new ApiError('Forbidden', 403); } },
    '@/lib/api': { ApiError, jsonError: error => Response.json({ error: error.message }, { status: error.status || 500 }) },
    '@/lib/application-groups': { updateApplicationGroup: async () => assert.fail('Mutation should not run') },
  });
  for (const method of ['POST', 'DELETE']) {
    const result = await api[method](new Request('http://localhost', { method, ...(method === 'POST' ? { body: '{}' } : {}) }), { params: Promise.resolve({ id: id1 }) });
    assert.equal(result.status, 403);
  }
});


test('staging-only creation makes one independent, deployable staging app in the staging directory', async () => {
  const result = await createProject({ environmentMode: 'staging', defaultBranch: 'develop' });
  assert.equal(result.response.status, 201);
  const app = await result.response.json();
  assert.equal(app.environment, 'staging');
  assert.equal(app.production_id, null);
  assert.equal(app.default_branch, 'develop');
  assert.equal(app.root_path, path.join(os.tmpdir(), 'STAGING_PATH', 'fixture'));
  assert.equal(app.auto_deploy, false);
  assert.equal(app.staging, undefined);
  assert.equal(result.portOptions[2], false, 'reserve only one port');
  assert.equal(result.calls.filter(call => call.sql?.includes('insert into projects')).length, 1);
  assert.equal(result.calls.filter(call => call.sql?.includes('insert into project_setup')).length, 1);
  assert.equal(result.calls.find(call => call.own).own[0], app.id);
  assert.deepEqual(result.calls.find(call => call.sql?.startsWith('select id from projects where port=any')).values, [[3217]]);
});

test('explicit modes retain production-only and paired creation', async () => {
  for (const [environmentMode, count] of [['production', 1], ['production-staging', 2]]) {
    const result = await createProject({ environmentMode });
    assert.equal(result.response.status, 201);
    const app = await result.response.json();
    assert.equal(app.environment, 'production');
    assert.equal(app.root_path, path.join(os.tmpdir(), 'PRODUCTION_PATH', 'fixture'));
    assert.equal(result.calls.filter(call => call.sql?.includes('insert into projects')).length, count);
    if (count === 2) assert.equal(app.staging.production_id, app.id);
  }
});

test('invalid or contradictory environment choices do not create any applications', async () => {
  for (const body of [{ environmentMode: 'preview' }, { environmentMode: 'staging', createStaging: true }, { environmentMode: 'production-staging', createStaging: false }]) {
    const result = await createProject(body);
    assert.equal(result.response.status, 400);
    assert.ok(!result.calls.some(call => call.sql?.includes('insert into projects')));
  }
});

test('standalone staging can join a project, but cannot implicitly move siblings with it', async () => {
  const writes = [];
  let others = 0;
  const client = { query: async (sql, values) => {
    if (sql.startsWith('select id,name')) return { rows: [
      { id: id1, environment: 'staging', production_id: null, application_group_id: 'solo' },
      { id: id2, environment: 'staging', production_id: null, application_group_id: groupId },
    ] };
    if (sql.includes('count(*)')) {
      assert.ok(sql.includes('production_id is null'), 'count standalone staging siblings too');
      return { rows: [{ count: others }] };
    }
    writes.push({ sql, values }); return { rows: [] };
  } };
  assert.equal(await groupApi().linkApplicationProjects(client, id1, id2, 'backend'), groupId);
  assert.equal(writes.filter(row => row.sql.startsWith('update projects')).length, 2);
  others = 1;
  await assert.rejects(groupApi().linkApplicationProjects(client, id1, id2, 'backend'), error => error.status === 409);
  const result = await createProject({ environmentMode: 'staging', relatedProjectId: id2, componentRole: 'backend' });
  assert.equal(result.response.status, 201);
  assert.deepEqual(result.calls.find(call => call.link).link, [id1, id2, 'backend']);
});
