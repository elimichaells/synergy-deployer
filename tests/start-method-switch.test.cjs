const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const load = require('./server-module.cjs');

// A switch stops the app, starts it the new way, and only records the new method once it is healthy.
async function harness(t, { healthy, status = 'online' }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-switch-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'server.js'), 'require("http").createServer().listen(process.env.PORT)');
  await fs.writeFile(path.join(root, 'package.json'), '{}');
  const calls = []; let healthChecks = 0; let released = false;
  const project = { id: 'p1', name: 'Fixture', repo_url: null, default_branch: 'main', project_type: 'node', root_path: root, install_cmd: null, build_cmd: null,
    deploy_script: null, start_cmd: 'node server.js', pre_deploy_cmd: null, post_deploy_cmd: null, runtime_versions: {}, pm2_name: 'fixture-app', port: 59871, github_connection_id: null };
  const query = async (sql, values) => {
    calls.push({ kind: 'query', sql, values });
    if (sql.includes('select memory_limit_mb, start_method')) return { rows: [{ memory_limit_mb: null, start_method: null }] };
    if (sql.includes('from projects where id=$1')) return { rows: [{ ...project }] };
    return { rows: [] };
  };
  const runCommand = async (cmd, cwd, _timeout, _stream, env) => {
    calls.push({ kind: 'command', cmd, cwd, env });
    if (cmd === 'pm2 jlist') return { code: 0, output: JSON.stringify([{ name: 'fixture-app', pid: 1, pm2_env: { status, pm_cwd: root } }]) };
    return { code: 0, output: '' };
  };
  const api = load('lib/deploy.ts', {
    '@/lib/db': { query }, '@/lib/exec': { runCommand },
    '@/lib/github-connections': { getGitHubConnectionToken: async () => '' },
    '@/lib/project-types': { normalizeProjectType: value => value || 'next', getProjectTypeDefaults: () => ({ installCmd: null, buildCmd: null, startCmd: null }), getProjectPortEnvironment: (_type, port) => ({ PORT: String(port) }) },
    '@/lib/notify': { notifyDeploy: async () => {}, sendNotification: async () => false }, '@/lib/project-databases': { getProjectDatabaseEnv: async () => ({}) },
    '@/lib/data-services': { getProjectDataServiceEnv: async () => ({}) }, '@/lib/runtimes': { projectRuntimeEnvironment: () => ({}) },
    '@/lib/deployment-health': { waitForDeploymentHealth: async () => { healthChecks++; return healthChecks === 1 ? { healthy, reason: healthy ? null : 'fixture health failed' } : { healthy: true }; } },
    '@/lib/deployment-command': { runDeploymentCommand: async () => ({ code: 0, output: '' }) },
    '@/lib/deployment-go': {}, '@/lib/deployment-git': {}, '@/lib/deployment-preparation': {}, '@/lib/deployment-runtime': require('../lib/deployment-runtime.ts'),
    '@/lib/deployment-terminals': {}, '@/lib/deployment-locks': {}, '@/lib/deployment-processes': {}, '@/lib/deployment-release': {}, '@/lib/deployment-cache': {},
    '@/lib/deployment-build-changes': {}, '@/lib/deployment-build-cache': {}, '@/lib/deployment-capacity': {}, '@/lib/deployment-schema': { ensureDeploymentSchema: async () => {} },
    '@/lib/ports': {}, '@/lib/caddy': {}, '@/lib/deployment-activation': {}, '@/lib/project-setup': {}, '@/lib/security-gate-policy': require('../lib/security-gate-policy.ts'),
    '@/lib/server-memory-policy': require('../lib/server-memory-policy.ts'), '@/lib/direct-start': require('../lib/direct-start.ts'),
    '@/lib/project-operation': { acquireProjectOperation: async () => async () => { released = true; } },
  });
  return { api, calls, root, released: () => released };
}

const commands = calls => calls.filter(call => call.kind === 'command').map(call => call.cmd);

test('a healthy switch starts the app directly, records the method and saves the PM2 list', async t => {
  const { api, calls, root, released } = await harness(t, { healthy: true });
  const result = await api.switchStartMethod('p1', 'direct');
  assert.deepEqual(result, { method: 'direct', healthy: true, reason: null, restored: false });
  const run = commands(calls);
  assert.ok(run.indexOf('pm2 delete "fixture-app"') < run.findIndex(cmd => cmd.startsWith('pm2 start')));
  assert.ok(run.find(cmd => cmd.startsWith('pm2 start')).startsWith(`pm2 start "${path.join(root, 'server.js')}" --interpreter node`));
  assert.ok(calls.some(call => call.kind === 'query' && call.sql.includes('update projects set start_method') && call.values[1] === 'direct'));
  assert.ok(run.includes('pm2 save'));
  assert.ok(released(), 'the app lock is released');
});

test('an unhealthy switch puts the app back on the runner and leaves the method unchanged', async t => {
  const { api, calls } = await harness(t, { healthy: false });
  const result = await api.switchStartMethod('p1', 'direct');
  assert.deepEqual(result, { method: 'direct', healthy: false, reason: 'fixture health failed', restored: true });
  const starts = commands(calls).filter(cmd => cmd.startsWith('pm2 start'));
  assert.equal(starts.length, 2);
  assert.ok(!starts[0].includes('pm2-runner') && starts[1].includes('pm2-runner'), starts.join('\n'));
  assert.equal(calls.some(call => call.kind === 'query' && call.sql.includes('update projects set start_method')), false);
});

test('a stopped app is not switched', async t => {
  const { api, calls } = await harness(t, { healthy: true, status: 'stopped' });
  await assert.rejects(api.switchStartMethod('p1', 'direct'), /only a running app can be switched/);
  assert.equal(commands(calls).some(cmd => cmd.startsWith('pm2 delete') || cmd.startsWith('pm2 start')), false);
});
