const test = require('node:test');
const assert = require('node:assert/strict');
const { workspaceHref, workspaceTabId, workspaceServer, restoreWorkspace, closeWorkspaceTab, openWorkspaceTab, resumeServer, workspaceKey, MAX_WORKSPACE_TABS } = require('../lib/workspace-navigation.ts');
const server = '11111111-1111-4111-8111-111111111111';
const remote = `/infrastructure/servers/${server}`;
const tab = (href, title = 'Application') => ({ id: workspaceTabId(href), href, title, server: workspaceServer(href) });

test('saved URLs contain only known navigation and never secrets or automatic actions', () => {
  assert.equal(workspaceHref('/sites/app?tab=environment&token=secret&new=1&password=hidden#unknown'), '/sites/app?tab=environment');
  assert.equal(workspaceHref('/settings?tab=updates&code=secret'), '/settings?tab=updates');
  assert.equal(workspaceHref('/settings?section=updates&secret=private'), '/settings?section=updates');
  for (const input of ['https://example.com', '//example.com', '/api/sites', '/login', '/unknown', '/sites/%2f..', '/sites\\evil', 'javascript:alert(1)', '/infrastructure/servers/deleted']) assert.equal(workspaceHref(input), null, input);
  assert.equal(workspaceHref(`${remote}#applications`), `${remote}#applications`);
});

test('restore validates scope from each URL and ignores forged metadata and unavailable servers', () => {
  const restored = restoreWorkspace(JSON.stringify({ tabs: [{ ...tab('/sites/local'), server, secret: 'do not retain' }, tab(remote), tab('/api/auth')], recent: ['/sites/local', remote, '/api/auth'] }), []);
  assert.equal(restored.tabs.length, 1);
  assert.equal(restored.tabs[0].server, 'local');
  assert.equal(restored.tabs[0].secret, undefined);
  assert.deepEqual(restored.recent, ['/sites/local']);
  assert.deepEqual(restoreWorkspace('corrupt', [server]), { tabs: [], recent: [] });
  assert.notEqual(workspaceKey('alice','admin'), workspaceKey('bob','admin'));
  assert.notEqual(workspaceKey('alice','admin'), workspaceKey('alice','viewer'));
});

test('an application retains its section without opening a tab for every section', () => {
  const tabs = openWorkspaceTab([tab('/sites/a?tab=overview')], tab('/sites/a?tab=environment', 'API'));
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].href, '/sites/a?tab=environment');
  assert.notEqual(workspaceTabId(remote), workspaceTabId(`${remote}#app-33333333-3333-4333-8333-333333333333`));
});

test('server switching resumes that server only and closing active pages prefers the same server', () => {
  const tabs = [tab('/overview'), tab('/sites/a?tab=environment'), tab(remote)];
  const recent = tabs.map(t => t.id);
  assert.equal(resumeServer(tabs, recent, 'local'), '/sites/a?tab=environment');
  assert.equal(resumeServer(tabs, recent, server), remote);
  assert.equal(closeWorkspaceTab(tabs, '/sites/a', '/sites/a', recent).href, '/overview');
  assert.equal(closeWorkspaceTab(tabs, remote, '/sites/a', recent).href, null);
  assert.equal(closeWorkspaceTab([tab(remote)], remote, remote, [remote]).href, '/');
});

test('workspace size is bounded and duplicate IDs are collapsed on restore', () => {
  let tabs = [];
  for (let i=0; i<MAX_WORKSPACE_TABS+10; i++) tabs = openWorkspaceTab(tabs, tab(`/sites/app-${i}`));
  assert.equal(tabs.length, MAX_WORKSPACE_TABS);
  assert.equal(restoreWorkspace(JSON.stringify({tabs:[tab('/overview'),tab('/overview')]}), []).tabs.length, 1);
});
