const assert = require('node:assert/strict');
const test = require('node:test');
const { environmentMode, isApplicationRoot, projectEnvironment } = require('../lib/application-environments.ts');
const load = require('./server-module.cjs');

test('legacy environment requests preserve their existing meaning', () => {
  assert.equal(environmentMode({}), 'production');
  assert.equal(environmentMode({ createStaging: false, setupDraft: true }), 'production');
  assert.equal(environmentMode({ createStaging: true, setupDraft: true }), 'production-staging');
  assert.throws(() => environmentMode({ setupDraft: true }), /Choose/);
  assert.throws(() => environmentMode({ environmentMode: null }), /Choose/);
  assert.throws(() => environmentMode({ createStaging: 'false' }), /Invalid/);
});

test('project app counts include standalone staging without double-counting paired copies', () => {
  const apps = [
    { environment: 'production', production_id: null },
    { environment: 'staging', production_id: 'production-app' },
    { environment: 'staging', production_id: null },
  ];
  assert.equal(apps.filter(isApplicationRoot).length, 2);
  assert.equal(projectEnvironment(apps, 'production'), 'production');
  assert.equal(projectEnvironment(apps, 'staging'), 'staging');
  assert.equal(projectEnvironment([apps[2]], 'production'), 'staging');
  assert.equal(projectEnvironment([apps[0]], 'staging'), 'production');
});

test('a standalone staging app cannot promote or look up an unrelated production target', async () => {
  let queries = 0;
  class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
  const api = load('lib/promotion.ts', {
    '@/lib/api': { ApiError },
    '@/lib/db': { query: async () => { queries++; return { rows: [{ id: 'staging-only', environment: 'staging', production_id: null }] }; } },
    '@/lib/exec': { runCommand: () => assert.fail('No Git operation is allowed') },
    '@/lib/deployment-schema': { ensureDeploymentSchema: async () => {} },
    '@/lib/github-webhooks': {}, '@/lib/promotion-policy': {},
  });
  await assert.rejects(api.getPromotionPlan('staging-only'), error => error.status === 400 && /not linked/.test(error.message));
  assert.equal(queries, 1);
});
