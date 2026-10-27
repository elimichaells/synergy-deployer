const test = require('node:test');
const assert = require('node:assert/strict');
const { remoteOverview, remoteWorkspaceView } = require('../lib/remote-server-overview.ts');
const now = Date.parse('2026-10-27T12:00:00Z');
const server = { id: 'one', enabled: true, status: 'online', last_seen_at: new Date(now).toISOString(), metrics: { apps: [{id:'app-one',status:'online'},{id:'foreign-app',status:'online'}] } };
const apps = [{id:'app-one',server_id:'one'}, {id:'app-two',server_id:'one'}, {id:'foreign-app',server_id:'two'}];
const job = (id, app, status, ago) => ({id,app_id:app,status,created_at:new Date(now-ago).toISOString()});

test('remote overview excludes another server and uses the latest result per app', () => {
  const result = remoteOverview(server, apps, [job('old','app-one','failed',10000),job('foreign','foreign-app','running',0),job('new','app-one','success',1000),job('queued','app-two','queued',0)], now);
  assert.deepEqual(result.apps.map(a=>a.id), ['app-one','app-two']);
  assert.deepEqual(result.jobs.map(j=>j.id), ['queued','new','old']);
  assert.equal(result.running, 1);
  assert.equal(result.active.length, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.successRate, 50);
  assert.equal(result.lastRelease.id, 'new');
});

test('stale, failed or revoked observations never present old process counts as live', () => {
  for (const patch of [{last_seen_at:new Date(now-91000).toISOString()}, {last_seen_at:null}, {status:'offline'}, {status:'revoked'}, {enabled:false}, {metrics:null}]) {
    const result = remoteOverview({...server,...patch},apps,[],now);
    assert.equal(result.fresh, false);
    assert.equal(result.running, null);
  }
  assert.equal(remoteOverview(server,apps,[],now,true).running, null);
});

test('empty and cancelled deployment history has no invented success rate', () => {
  assert.equal(remoteOverview(server,apps,[],now).successRate, null);
  assert.equal(remoteOverview(server,apps,[job('cancel','app-one','cancelled',0)],now).successRate, null);
  assert.equal(remoteOverview(server,apps,[job('fail','app-one','failed',0)],now).failed, 1);
});

test('remote views accept only supported sections and application identifiers', () => {
  for (const section of ['applications','deployments','server-access']) assert.equal(remoteWorkspaceView('#'+section), section);
  assert.equal(remoteWorkspaceView('#app-33333333-3333-4333-8333-333333333333'),'app');
  for (const hash of ['','#unknown','#app-secret','/overview']) assert.equal(remoteWorkspaceView(hash),'overview');
});
