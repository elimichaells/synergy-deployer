const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('./server-module.cjs');
const api = require('../lib/api.ts');
const rbac = require('../lib/rbac.ts');

function logRoute(role, query) {
  return load('app/api/deployments/[id]/route.ts', {
    '@/lib/db': {query}, '@/lib/auth': {getSessionFromCookie: async () => role ? {role} : null},
    '@/lib/rbac': rbac, '@/lib/api': api, '@/lib/deployment-schema': {ensureDeploymentSchema: async () => {}},
  });
}
const context = {params: Promise.resolve({id: 'fixture'})};
test('incremental log API validates cursor, keeps Unicode offsets and avoids returning the full log', async () => {
  let calls = 0;
  const route = logRoute('viewer', async (sql, values) => {
    calls++; assert.match(sql, /substring/); assert.deepEqual(values, ['fixture', 0]);
    return {rows: [{id: 'fixture', status: 'running', log_chunk: 'A😀', log_length: 3, log_reset: false}]};
  });
  const response = await route.GET(new Request('http://test/api/deployments/fixture?after=0'), context);
  const body = await response.json(); assert.equal(body.log_next, 2); assert.equal(body.log_complete, false); assert.equal(body.log, undefined);
  for (const value of ['-1','abc','1.5','2147483648']) assert.equal((await route.GET(new Request('http://test/api/deployments/fixture?after='+value), context)).status, 400);
  assert.equal(calls, 1);
});
test('deployment logs require authentication before accessing the database', async () => {
  const route = logRoute(null, () => { throw new Error('Must not query'); });
  assert.equal((await route.GET(new Request('http://test/api/deployments/fixture'), context)).status, 401);
});
test('viewer cannot change readiness settings; invalid profiles never save or audit', async () => {
  let role = 'viewer', saved = 0, audited = 0;
  const route = load('app/api/sites/[id]/health/route.ts', {
    '@/lib/auth': {getSessionFromCookie: async () => ({role})}, '@/lib/rbac': rbac, '@/lib/api': api,
    '@/lib/db': {query: async () => ({rows:[{pm2_name:'fixture'}]})},
    '@/lib/audit': {audit: async () => audited++}, '@/lib/server-health': {readServerHealth: async () => ({})},
    '@/lib/health-profiles': {saveApplicationHealthProfile: async (_name, input) => { const profile = require('../scripts/http-health.cjs').validateHealthProfile(input); saved++; return profile; }},
  });
  const request = value => new Request('http://test/api/sites/fixture/health', {method:'PATCH', body:JSON.stringify(value)});
  assert.equal((await route.PATCH(request({path:'/health'}), context)).status,403);
  role = 'operator'; assert.equal((await route.PATCH(request({path:'//external'}), context)).status,400);
  assert.equal(saved,0); assert.equal(audited,0);
  assert.equal((await route.PATCH(request({path:'/health'}), context)).status,200); assert.equal(saved,1); assert.equal(audited,1);
});
