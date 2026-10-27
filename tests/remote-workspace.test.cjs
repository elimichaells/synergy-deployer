const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('./server-module.cjs');
const { remoteDeployment, remotePipeline, remoteProcessState, remoteAppHref } = load('lib/remote-workspace.ts');
const { remoteOverview, remoteWorkspaceView } = load('lib/remote-server-overview.ts');
const { environmentText, parseEnvironmentText } = load('lib/environment-text.ts');
const { workspaceHref, restoreWorkspace, workspaceTabId, openWorkspaceTab } = load('lib/workspace-navigation.ts', { './server-navigation': load('lib/server-navigation.ts') });
const serverId = '11111111-1111-4111-8111-111111111111';
const appId = '33333333-3333-4333-8333-333333333333';
const app = { id: appId, server_id: serverId, name: 'Library', branch: 'main', live_commit: 'abc', deployed_at: '2026-10-27T12:00:00Z' };
const job = { id: '55555555-5555-4555-8555-555555555555', app_id: appId, status: 'success', commit_sha: 'abc', started_at: '2026-10-27T11:59:00Z', created_at: '2026-10-27T11:59:00Z', finished_at: app.deployed_at, log: '[stage] checkout\n[stage] install\n[stage] build\n[stage] activate\n[stage] health\n[stage] caddy\n' };
test('shared release links stay scoped to the selected server and reject unrelated apps', () => {
  const release = remoteDeployment(job, [app]);
  assert.equal(release.href, `/infrastructure/servers/${serverId}?view=${job.id}#deployments`);
  assert.equal(release.is_active, true);
  assert.equal(remoteDeployment({ ...job, finished_at: '2026-10-26T12:00:00Z' }, [app]).is_active, false);
  assert.throws(() => remoteDeployment(job, []), /does not belong/);
});
test('remote pipeline only reports stages actually performed, including optional skipped build', () => {
  const stages = remotePipeline({ ...job, log: job.log.replace('[stage] build\n', '') });
  assert.equal(stages.find(s => s.key === 'build').state, 'skipped');
  assert.equal(stages.find(s => s.key === 'routing').state, 'done');
  assert.ok(!stages.some(s => ['security','preflight'].includes(s.key)));
  const failed = remotePipeline({ ...job, status: 'failed', log: '[stage] checkout\n[stage] install\n[error] install failed' });
  assert.equal(failed.find(s => s.key === 'install').state, 'failed');
  assert.equal(failed.find(s => s.key === 'activate').state, 'pending');
  assert.ok(remotePipeline({ ...job, status: 'queued' }).every(s => s.state === 'pending'));
  assert.ok(remotePipeline({ ...job, status: 'cancelled' }).every(s => s.state === 'skipped'));
});
test('overview excludes setup jobs, foreign apps, and stale process health', () => {
  const server = { id: serverId, enabled:true, status:'online', last_seen_at:'2026-10-27T12:00:00Z', metrics:{apps:[{id:appId,status:'online'}]} };
  const now = Date.parse(server.last_seen_at);
  const summary = remoteOverview(server, [app, {...app,id:'foreign',server_id:'other'}], [job,{...job,id:'inspect',kind:'inspect'},{...job,id:'foreign-job',app_id:'foreign'}], now);
  assert.deepEqual(summary.jobs.map(item => item.id), [job.id]);
  assert.equal(summary.running,1);
  assert.equal(remoteProcessState(server,app,false).label,'Unknown');
  assert.equal(remoteOverview(server,[app],[job],now+91000).running,null);
});
test('workspace restores remote tabs, import and resource pages without secrets', () => {
  for (const hash of ['#new','#storage','#domains','#server-access']) {
    const href = `/infrastructure/servers/${serverId}${hash}`;
    assert.equal(workspaceHref(href),href);
    assert.notEqual(remoteWorkspaceView(hash),'overview');
  }
  const href = remoteAppHref(serverId,appId,'environment');
  assert.equal(workspaceHref(href.replace('#','&password=secret#')),href);
  const restored = restoreWorkspace(JSON.stringify({tabs:[{href,title:'Library'}]}),[serverId]);
  assert.equal(restored.tabs[0].server,serverId);
  assert.equal(restored.tabs[0].href,href);
});
test('environment text preserves spaces, quotes, backslashes, hashes and multiline secrets', () => {
  const values = { API_KEY:'abc#12', JSON:'{"a":"b"}', WINDOWS:'C:\\web\\app', PRIVATE:'line1\nline2', EMPTY:'', SPACES:'  a  ', LITERAL:'${HOME}' };
  assert.deepEqual({...parseEnvironmentText(environmentText(values))},values);
  assert.deepEqual({...parseEnvironmentText("# comment\nexport PORT=3001\nNAME='hello world'\nMODE=prod # note")},{PORT:'3001',NAME:'hello world',MODE:'prod'});
  assert.throws(() => parseEnvironmentText('BAD LINE'), /Line 1/);
  assert.throws(() => parseEnvironmentText('KEY=a\nKEY=b'), /duplicate/);
  assert.throws(() => parseEnvironmentText('KEY="unterminated'), /Line 1/);
});

test('remote overview, projects, deployment history and individual releases keep separate compact tabs', () => {
  const root = `/infrastructure/servers/${serverId}`;
  const pages = [root,`${root}#applications`,`${root}#deployments`,`${root}?view=${job.id}#deployments`,`${root}#new`,`${root}#storage`,`${root}#server-access`,`${root}?section=agent#server-access`];
  assert.equal(new Set(pages.map(workspaceTabId)).size,pages.length);
  assert.equal(workspaceTabId(remoteAppHref(serverId,appId,'overview')),workspaceTabId(remoteAppHref(serverId,appId,'environment')));
  const tab = {id:workspaceTabId(remoteAppHref(serverId,appId)),href:remoteAppHref(serverId,appId),server:serverId,title:'Library',environment:'staging'};
  assert.equal(openWorkspaceTab([tab],{...tab,environment:undefined})[0].environment,'staging');
});
