const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const load = require('./server-module.cjs');

test('host installation slots serialize heavy work and release on failure', async () => {
  let locked = false; let running = 0; let maximum = 0; let releases = 0;
  const api = load('lib/deployment-capacity.ts', { '@/lib/db': { db: { connect: async () => {
    const client = new EventEmitter();
    client.query = async sql => { if (sql.includes('try_advisory')) { const acquired = !locked; if (acquired) locked = true; return { rows: [{ locked: acquired }] }; } locked = false; return { rows: [] }; };
    client.release = () => { releases++; }; return client;
  } } } });
  const work = async () => { running++; maximum = Math.max(maximum, running); await new Promise(resolve => setTimeout(resolve, 50)); running--; };
  await Promise.all([api.withInstallationSlot(work, () => {}, () => {}), api.withInstallationSlot(work, () => {}, () => {})]);
  assert.equal(maximum, 1); assert.equal(locked, false); assert.ok(releases >= 2);
  await assert.rejects(api.withInstallationSlot(async () => { throw new Error('fixture install failure'); }, () => {}, () => {}));
  assert.equal(locked, false);
  assert.equal(api.installationLimit(), 2);
  for (const value of ['0', '5', '1.2', 'NaN']) assert.throws(() => api.installationLimit(value));
});

test('cancelled installation queue never starts work or leaks a connection', async () => {
  let connections = 0;
  const api = load('lib/deployment-capacity.ts', { '@/lib/db': { db: { connect: async () => { connections++; throw new Error('must not connect'); } } } });
  await assert.rejects(api.withInstallationSlot(async () => assert.fail(), () => {}, () => { throw new Error('cancelled'); }), /cancelled/);
  assert.equal(connections, 0);
});

async function pipeline(t, failure, cacheHit = false) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-pipeline-test-'));
  t.after(async () => { assert.ok(base.startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(base, { recursive: true, force: true }); });
  const root = path.join(base, 'live'); const candidate = path.join(base, 'candidate');
  await fs.mkdir(root); await fs.mkdir(candidate);
  await fs.writeFile(path.join(root, '.env'), 'APPLICATION_MARKER=fixture');
  await fs.writeFile(path.join(candidate, '.env'), 'APPLICATION_MARKER=fixture');
  await fs.writeFile(path.join(candidate, 'package.json'), '{}');
  await fs.writeFile(path.join(candidate, 'package-lock.json'), '{}');
  const calls = []; let status = 'online'; let seq = 0; let previewName;
  const project = { id: 'fixture-project', name: 'Fixture', root_path: root, project_type: 'angular', repo_url: 'https://github.com/example/fixture',
    default_branch: 'main', install_cmd: null, build_cmd: 'npm run build', start_cmd: null, pm2_name: 'fixture-app', port: 3217 };
  const query = async (sql, values) => {
    calls.push({ kind: 'query', sql, values });
    if (sql.includes('INSERT INTO deployments')) return { rows: [{ id: 'fixture-' + (++seq) }] };
    if (sql.includes('select hostname from project_domains')) return { rows: [{ hostname: 'fixture.example.com' }] };
    return { rows: [] };
  };
  const command = async (cmd, cwd, _timeout, _stream, env) => {
    calls.push({ kind: 'command', cmd, cwd, env });
    if (cmd === 'pm2 jlist') return { code: 0, output: JSON.stringify([
      ...(status === 'missing' ? [] : [{ name: project.pm2_name, pid: 100, pm2_env: { status, pm_exec_path: 'fixture-server.js', pm_cwd: root, env: { PORT: '3217' } } }]),
      ...(previewName ? [{ name: previewName, pid: 101, pm2_env: { status: 'online', pm_exec_path: 'fixture-server.js', pm_cwd: candidate } }] : []),
    ]) };
    if (cmd.startsWith('pm2 start') && cmd.includes(':candidate:')) previewName = cmd.match(/fixture-app:candidate:[a-zA-Z0-9-]+/)[0];
    if (cmd.startsWith('pm2 delete') && cmd.includes(':candidate:')) previewName = undefined;
    if (cmd.startsWith('pm2 delete') && !cmd.includes(':candidate:')) status = 'missing';
    if (cmd.startsWith('pm2 start') && !cmd.includes(':candidate:')) status = 'online';
    return { code: 0, output: cmd === 'git rev-parse HEAD' ? 'a'.repeat(40) : '' };
  };
  const prep = {
    defaultInstallCommand: async () => 'npm ci --include=dev', detectCheckoutProjectType: async () => 'angular',
    prepareProjectCheckout: async () => {}, prepareProjectParent: async () => {}, resolveCheckoutCommands: p => p,
    localNpmInstall: cmd => cmd.startsWith('npm ci') ? 'ci' : undefined,
    runPreparedDeploymentCommand: (cmd, _root, execute) => execute(cmd),
  };
  const cache = load('lib/deployment-cache.ts', { './deployment-preparation': prep });
  const api = load('lib/deploy.ts', {
    '@/lib/db': { query }, '@/lib/exec': { runCommand: command },
    '@/lib/github-connections': { getGitHubConnectionToken: async () => 'fixture-token' },
    '@/lib/project-types': { normalizeProjectType: value => value || 'next', getProjectTypeDefaults: () => ({ installCmd: null, buildCmd: 'npm run build', startCmd: null }), getProjectPortEnvironment: (_type, port) => ({ PORT: String(port) }) },
    '@/lib/notify': { notifyDeploy: async () => {} }, '@/lib/project-databases': { getProjectDatabaseEnv: async () => ({}) },
    '@/lib/data-services': { getProjectDataServiceEnv: async () => ({}) }, '@/lib/runtimes': { projectRuntimeEnvironment: () => ({}) },
    '@/lib/deployment-health': { waitForDeploymentHealth: async () => { const previousChecks = calls.filter(call => call.kind === 'health').length; calls.push({ kind: 'health' }); return { healthy: failure !== 'health' || previousChecks > 0, reason: 'fixture health failed' }; } },
    '@/lib/deployment-command': { runDeploymentCommand: async (cmd, cwd, env) => {
      calls.push({ kind: 'build-command', cmd, cwd, env });
      if (cmd.startsWith('npm audit')) return { code: failure === 'audit' ? 1 : 0, output: JSON.stringify({ vulnerabilities: failure === 'audit' ? { 'fixture-package': { severity: 'high', range: '<2.0.0', via: [{ title: 'Fixture vulnerability', url: 'https://github.com/advisories/GHSA-fixture' }], fixAvailable: true } } : {}, metadata: { vulnerabilities: { low: 0, moderate: 0, high: failure === 'audit' ? 1 : 0, critical: 0 } } }) };
      return { code: (failure === 'install' && cmd.startsWith('npm ci')) || (failure === 'build' && cmd === 'npm run build') ? 1 : 0, output: '' };
    } },
    '@/lib/deployment-go': {}, '@/lib/deployment-git': { assertCleanDeploymentCheckout: async () => {}, syncDeploymentCheckout: async () => {} },
    '@/lib/deployment-preparation': prep,
    '@/lib/deployment-runtime': require('../lib/deployment-runtime.ts'),
    '@/lib/deployment-terminals': { recoverProjectTerminalLocks: async root => { calls.push({ kind: 'terminal-recovery', root }); } },
    '@/lib/deployment-locks': { logProjectDirectoryHandles: async () => {} },
    '@/lib/deployment-processes': {
      captureProjectProcesses: async processRoot => { calls.push({ kind: 'process-snapshot', root: processRoot }); return { root: processRoot }; },
      stopProjectProcesses: async snapshot => { calls.push({ kind: 'process-stop', root: snapshot.root }); if (failure === 'process-stop' && snapshot.root === root && calls.filter(c => c.kind === 'process-stop' && c.root === root).length === 1) throw new Error('Project process still alive'); if (failure === 'preview-stop' && snapshot.root === candidate) throw new Error('Preview process still alive'); },
    },
    '@/lib/deployment-release': { sourceFingerprint: async () => 'same', DeploymentRelease: class {
      constructor() { this.base = base; this.candidate = candidate; this.previous = path.join(base, 'previous'); this.cache = path.join(base, 'cache'); }
      async prepare() { calls.push({ kind: 'prepare' }); }
      async activate(recoverLock) { calls.push({ kind: 'activate' }); if (failure === 'terminal-lock') await recoverLock(); }
      async rollback() { calls.push({ kind: 'rollback' }); }
      async complete() { calls.push({ kind: 'complete' }); }
    } },
    '@/lib/deployment-cache': { assertAuditPassed: cache.assertAuditPassed, formatAuditFindings: cache.formatAuditFindings, installWithDependencyCache: async options => {
      calls.push({ kind: cacheHit ? 'cache-hit' : 'install' }); return cacheHit ? { code: 0, output: '' } : options.execute(options.command);
    } },
    '@/lib/deployment-capacity': { withInstallationSlot: async work => { calls.push({ kind: 'capacity' }); return work(); } },
    '@/lib/deployment-schema': { ensureDeploymentSchema: async () => {} },
    '@/lib/ports': { allocateTemporaryPort: async () => 43217 },
    '@/lib/caddy': { updateCaddyDomainsStrict: async (hostnames, port) => { calls.push({ kind: 'caddy', hostnames, port }); } },
    '@/lib/deployment-activation': { beginReleaseActivation: async () => { calls.push({ kind: 'activation-admission' }); } },
    '@/lib/project-setup': { assertProjectSetupComplete: async () => {} },
    '@/lib/project-operation': { acquireProjectOperation: async () => async () => {} },
  });
  const result = await api.runDeploy(project, { trigger: 'manual' });
  return { calls, result, root, candidate };
}

for (const failure of ['install', 'build', 'audit']) test(failure + ' failure never stops or replaces the current application', async t => {
  const { calls, result } = await pipeline(t, failure);
  assert.equal(result.status, 'failed');
  assert.equal(calls.some(call => call.kind === 'activate'), false);
  assert.equal(calls.some(call => call.kind === 'terminal-recovery'), false);
  assert.equal(calls.some(call => call.kind === 'command' && /^pm2 (?:stop|delete|start|restart)/.test(call.cmd)), false);
  assert.equal(calls.some(call => call.kind === 'query' && call.sql.includes('SET active_deployment_id')), false);
  if (failure === 'audit') {
    assert.match(result.log, /high: fixture-package/);
    assert.match(result.log, /https:\/\/github.com\/advisories\/GHSA-fixture/);
    assert.match(result.log, /Compatible update available/);
  }
});

test('cached deployments still audit, build separately, then activate on the assigned port', async t => {
  const { calls, result, candidate, root } = await pipeline(t, undefined, true);
  assert.equal(result.status, 'success');
  assert.equal(calls.some(call => call.kind === 'terminal-recovery'), false);
  const auditIndex = calls.findIndex(call => call.kind === 'build-command' && call.cmd.startsWith('npm audit'));
  const activateIndex = calls.findIndex(call => call.kind === 'activate');
  assert.ok(auditIndex > 0 && activateIndex > auditIndex);
  assert.ok(calls[auditIndex].cmd.includes('--omit=dev'));
  assert.ok(!calls[auditIndex].cmd.includes('--include=dev'));
  assert.ok(calls.findIndex(call => call.kind === 'process-snapshot') < calls.findIndex(call => call.kind === 'command' && call.cmd.startsWith('pm2 delete') && !call.cmd.includes(':candidate:')));
  assert.ok(calls.findIndex(call => call.kind === 'process-stop') < activateIndex);
  assert.ok(calls.some(call => call.kind === 'cache-hit'));
  assert.ok(calls.filter(call => call.kind === 'build-command').every(call => call.cwd === candidate));
  const start = calls.find(call => call.kind === 'command' && call.cmd.startsWith('pm2 start') && call.cwd === root);
  assert.equal(start.cwd, root); assert.equal(start.env.PORT, '3217');
  const preview = calls.find(call => call.kind === 'command' && call.cmd.startsWith('pm2 start') && call.cwd === candidate);
  assert.equal(preview.env.PORT, '43217');
  assert.ok(calls.findIndex(call => call.kind === 'health') < activateIndex);
  assert.deepEqual(calls.filter(call => call.kind === 'caddy').map(call => call.port), process.platform === 'win32' ? [] : [43217, 3217]);
  if (process.platform === 'win32') {
    const previewStop = calls.findIndex(call => call.kind === 'process-stop' && call.root === candidate);
    const liveStop = calls.findIndex(call => call.kind === 'process-stop' && call.root === root);
    assert.ok(previewStop >= 0 && previewStop < liveStop && liveStop < activateIndex);
  }
});

test('process shutdown verification failure never moves the live release', async t => {
  const { calls, result } = await pipeline(t, 'process-stop');
  assert.equal(result.status, 'failed');
  assert.equal(calls.some(call => call.kind === 'activate'), false);
  assert.ok(calls.some(call => call.kind === 'rollback'));
});

test('activation can recover terminal locks only after project shutdown and against the live project root', async t => {
  const { calls, result, root } = await pipeline(t, 'terminal-lock');
  assert.equal(result.status, 'success');
  const recovery = calls.findIndex(call => call.kind === 'terminal-recovery');
  assert.ok(recovery > calls.findIndex(call => call.kind === 'activate'));
  assert.ok(recovery > calls.findIndex(call => call.kind === 'process-stop'));
  assert.equal(calls[recovery].root, root);
  assert.equal(calls.filter(call => call.kind === 'terminal-recovery').length, 1);
});

test('failed candidate preflight leaves the current directory and process untouched', async t => {
  const { calls, result, root, candidate } = await pipeline(t, 'health');
  assert.equal(result.status, 'failed');
  assert.equal(calls.some(call => call.kind === 'activate'), false);
  assert.equal(calls.some(call => call.kind === 'rollback'), false);
  assert.equal(calls.filter(call => call.kind === 'command' && call.cmd.startsWith('pm2 start')).length, 1);
  assert.equal(calls.some(call => call.kind === 'query' && call.sql.includes('SET active_deployment_id')), false);
  assert.equal(calls.some(call => call.kind === 'process-stop' && call.root === root), false);
  assert.equal(calls.some(call => call.kind === 'process-stop' && call.root === candidate), true);
});

test('a preview that cannot be stopped blocks Windows activation while the live service stays online', { skip: process.platform !== 'win32' }, async t => {
  const { calls, result, root } = await pipeline(t, 'preview-stop');
  assert.equal(result.status, 'failed');
  assert.equal(calls.some(call => call.kind === 'activate'), false);
  assert.equal(calls.some(call => call.kind === 'process-stop' && call.root === root), false);
  assert.equal(calls.some(call => call.kind === 'command' && call.cmd.startsWith('pm2 delete') && !call.cmd.includes(':candidate:')), false);
});
