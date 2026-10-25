const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('./server-module.cjs');
const policy = require('../lib/server-navigation.ts');
const navigation = load('components/synergy/nav.ts', { '@/lib/server-navigation': policy });
const id = '11111111-1111-4111-8111-111111111111';

test('server context follows the URL so local deep links never inherit a remote selection', () => {
  for (const path of ['/', '/settings', '/infrastructure/servers']) assert.equal(policy.serverScope(path).kind, 'fleet');
  for (const path of ['/overview', '/sites/new', '/sites/existing-app', '/projects', '/storage', '/deployments', '/services', '/infrastructure/health']) assert.equal(policy.serverScope(path).kind, 'local');
  assert.deepEqual(policy.serverScope(`/infrastructure/servers/${id}`), { kind: 'remote', id });
  // Invalid or missing remote servers must remain remote errors, never show local data.
  assert.equal(policy.serverScope('/infrastructure/servers/deleted-server').kind, 'remote');
});

test('remote workspace navigation cannot invoke manager-host tools', () => {
  const root = policy.serverOverview(id);
  const items = navigation.workspaceNavItems(root);
  assert.deepEqual(items.map(item => item.label), ['Servers', 'Overview', 'Applications', 'Deployments', 'Server access', 'Settings']);
  for (const item of items) assert.ok(item.href === '/' || item.href === '/settings' || item.href === root || item.href.startsWith(root + '#'), item.href);
  assert.ok(navigation.workspaceNavItems('/overview').some(item => item.href === '/projects'));
  assert.deepEqual(navigation.workspaceNavItems('/').map(item => item.href), ['/', '/settings']);
});

test('remembered server destinations accept only local or server identifiers', () => {
  assert.equal(policy.serverOverview('local'), '/overview');
  assert.equal(policy.serverOverview(id), `/infrastructure/servers/${id}`);
  for (const value of ['https://other.example', '../settings', 'javascript:alert(1)', 'deleted-server', '']) assert.equal(policy.serverOverview(value), '/');
  assert.notEqual(policy.recentServerKey('user-one'), policy.recentServerKey('user-two'));
});
