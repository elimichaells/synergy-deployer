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

async function pipeline(t, failure, cacheHit = false, options = { trigger: 'manual' }, notAncestor = false, gateOffReason = null) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-pipeline-test-'));
  t.after(async () => { assert.ok(base.startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(base, { recursive: true, force: true }); });
  const root = path.join(base, 'live'); const candidate = path.join(base, 'candidate');
  await fs.mkdir(root); await fs.mkdir(candidate);
  await fs.writeFile(path.join(root, '.env'), 'APPLICATION_MARKER=fixture');
  await fs.writeFile(path.join(candidate, '.env'), 'APPLICATION_MARKER=fixture');
  await fs.writeFile(path.join(candidate, 'package.json'), '{}');
  await fs.writeFile(path.join(candidate, 'package-lock.json'), '{}');
  const checkout = failure === 'local-edits' || failure === 'generated-files';
  if (checkout) { await fs.mkdir(path.join(root, '.git')); await fs.mkdir(path.join(candidate, '.git')); }
  const calls = []; let status = 'online'; let seq = 0; let previewName; let audits = 0; let builds = 0;
  const project = { id: 'fixture-project', name: 'Fixture', root_path: root, project_type: 'angular', repo_url: 'https://github.com/example/fixture',
    default_branch: 'main', install_cmd: null, build_cmd: 'npm run build', start_cmd: null, pm2_name: 'fixture-app', port: 3217 };
  const query = async (sql, values) => {
    calls.push({ kind: 'query', sql, values });
    if (sql.includes('INSERT INTO deployments')) return { rows: [{ id: 'fixture-' + (++seq) }] };
    if (sql.includes('select hostname from project_domains')) return { rows: [{ hostname: 'fixture.example.com' }] };
    if (sql.includes('security_gate_off_until')) return { rows: [{ off: gateOffReason ? true : null, reason: gateOffReason }] };
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
    // For the shared-branch promotion check: production does not yet contain the staging commit.
    if (notAncestor && /^git merge-base --is-ancestor "[a-f0-9]+" HEAD$/.test(cmd)) return { code: 1, output: '' };
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
      if (cmd.startsWith('npm audit')) {
        audits++;
        const blocked = failure === 'audit' || (failure === 'final-audit' && audits === 2);
        return { code: blocked ? 1 : 0, output: JSON.stringify({ vulnerabilities: blocked ? { 'fixture-package': { severity: 'high', range: '<2.0.0', via: [{ title: 'Fixture vulnerability', url: 'https://github.com/advisories/GHSA-fixture' }], fixAvailable: true } } : {}, metadata: { vulnerabilities: { low: 0, moderate: 0, high: blocked ? 1 : 0, critical: 0 } } }) };
      }
      return { code: (failure === 'install' && cmd.startsWith('npm ci')) || (failure === 'build' && cmd === 'npm run build') || (failure === 'build-once' && cmd === 'npm run build' && builds++ === 0) ? 1 : 0, output: '' };
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
    '@/lib/deployment-cache': { loadAuditExceptions: () => [], assertAuditPassed: cache.assertAuditPassed, formatAuditFindings: cache.formatAuditFindings, installWithDependencyCache: async options => {
      calls.push({ kind: cacheHit ? 'cache-hit' : 'install' }); return cacheHit ? { code: 0, output: '' } : options.execute(options.command);
    } },
    '@/lib/deployment-build-changes': {
      inspectLocalChanges: async () => ({ paths: checkout ? ['public/widget.js'] : [], complex: [], hashes: {}, mtimes: {}, contentChanged: [] }),
      classifyLocalChanges: () => failure === 'local-edits' ? { generated: [], unexplained: ['public/widget.js'], inferred: false }
        : { generated: checkout ? ['public/widget.js'] : [], unexplained: [], inferred: false },
      localChangesMessage: files => 'Local source changes detected: ' + files.join(', '),
      recordBuildChanges: async () => { calls.push({ kind: 'record-build-changes' }); return {}; },
      restoreGeneratedFiles: async (_execute, directory, files) => { calls.push({ kind: 'restore-generated', directory, files }); },
    },
    '@/lib/deployment-build-cache': {
      seedBuildCache: async () => failure === 'build-once' || failure === 'build' ? [path.join(candidate, '.next/cache')] : [],
      discardSeededCaches: async seeded => { calls.push({ kind: 'discard-build-cache', seeded }); },
    },
    '@/lib/deployment-capacity': { withInstallationSlot: async work => { calls.push({ kind: 'capacity' }); return work(); } },
    '@/lib/deployment-schema': { ensureDeploymentSchema: async () => {} },
    '@/lib/security-gate-policy': require('../lib/security-gate-policy.ts'),
    '@/lib/ports': { allocateTemporaryPort: async () => 43217 },
    '@/lib/caddy': { updateCaddyDomainsStrict: async (hostnames, port) => { calls.push({ kind: 'caddy', hostnames, port }); } },
    '@/lib/deployment-activation': { beginReleaseActivation: async () => { calls.push({ kind: 'activation-admission' }); } },
    '@/lib/project-setup': { assertProjectSetupComplete: async () => {} },
    '@/lib/project-operation': { acquireProjectOperation: async () => async () => {} },
  });
  const result = await api.runDeploy(project, options);
  return { calls, result, root, candidate };
}

for (const failure of ['install', 'build', 'audit', 'final-audit']) test(failure + ' failure never stops or replaces the current application', async t => {
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

test('a build that fails with the reused build cache is retried once from scratch, then activates', async t => {
  const { calls, result, candidate } = await pipeline(t, 'build-once');
  assert.equal(result.status, 'success');
  assert.equal(calls.filter(call => call.kind === 'build-command' && call.cmd === 'npm run build').length, 2);
  const discard = calls.findIndex(call => call.kind === 'discard-build-cache');
  const builds = calls.map((call, index) => call.kind === 'build-command' && call.cmd === 'npm run build' ? index : -1).filter(index => index >= 0);
  assert.ok(builds[0] < discard && discard < builds[1]);
  assert.deepEqual(calls[discard].seeded, [path.join(candidate, '.next/cache')]);
  assert.match(result.log, /retrying once from scratch/);
  assert.ok(calls.some(call => call.kind === 'activate'));
});

test('a build that fails again without the cache still fails and never replaces the live app', async t => {
  const { calls, result } = await pipeline(t, 'build');
  assert.equal(result.status, 'failed');
  assert.equal(calls.filter(call => call.kind === 'build-command' && call.cmd === 'npm run build').length, 2);
  assert.equal(calls.some(call => call.kind === 'activate'), false);
});

test('files the last build rewrote are regenerated in the candidate only, and the deployment proceeds', async t => {
  const { calls, result, candidate } = await pipeline(t, 'generated-files');
  assert.equal(result.status, 'success');
  const restore = calls.find(call => call.kind === 'restore-generated');
  assert.equal(restore.directory, candidate);
  assert.deepEqual(restore.files, ['public/widget.js']);
  assert.ok(calls.findIndex(call => call.kind === 'restore-generated') < calls.findIndex(call => call.kind === 'build-command' && call.cmd === 'npm run build'));
  assert.ok(calls.findIndex(call => call.kind === 'record-build-changes') < calls.findIndex(call => call.kind === 'activate'));
  assert.ok(calls.some(call => call.kind === 'query' && call.sql.includes('SET build_changes')));
  assert.match(result.log, /rewritten by the last deployment's own install or build/);
});

test('a hand edit to a committed file still stops the deployment before anything is built', async t => {
  const { calls, result } = await pipeline(t, 'local-edits');
  assert.equal(result.status, 'failed');
  assert.match(result.log, /Local source changes detected/);
  assert.equal(calls.some(call => call.kind === 'restore-generated'), false);
  assert.equal(calls.some(call => call.kind === 'build-command'), false);
  assert.equal(calls.some(call => call.kind === 'activate'), false);
});

const promoted = 'b'.repeat(40);
const gitCommands = calls => calls.filter(call => call.kind === 'command' && call.cmd.startsWith('git ')).map(call => call.cmd);

test('promotion merges the exact commit staging ran and updates GitHub only after production is healthy', async t => {
  const { calls, result, root } = await pipeline(t, undefined, false, { trigger: 'promote', mergeBranch: 'dev', mergeCommit: promoted });
  assert.equal(result.status, 'success');
  const git = gitCommands(calls);
  assert.ok(git.some(cmd => cmd.startsWith('git merge-base --is-ancestor "' + promoted + '" "origin/dev"')));
  const merge = git.find(cmd => cmd.startsWith('git merge "'));
  assert.ok(merge.startsWith('git merge "' + promoted + '"'), merge);
  assert.ok(merge.includes('Promote dev (bbbbbbb) to main'), merge);
  assert.equal(git.some(cmd => cmd.startsWith('git merge "origin/dev"')), false);
  const index = predicate => calls.findIndex(predicate);
  const dryRun = index(call => call.kind === 'command' && call.cmd.startsWith('git push --dry-run'));
  const push = index(call => call.kind === 'command' && call.cmd.startsWith('git push "'));
  const activate = index(call => call.kind === 'activate');
  const lastHealth = calls.map((call, i) => call.kind === 'health' ? i : -1).filter(i => i >= 0).pop();
  assert.ok(dryRun >= 0 && dryRun < activate, 'the dry run happens before activation');
  assert.ok(push > activate && push > lastHealth, 'the real push happens after activation and the final health check');
  assert.equal(calls[push].cwd, root, 'the push runs from the live checkout');
  assert.equal(calls.filter(call => call.kind === 'command' && call.cmd.startsWith('git push "')).length, 1);
  assert.match(result.log, /main on GitHub now matches what production runs/);
});

test('a promotion that fails its test start never moves the branch on GitHub', async t => {
  const { calls, result } = await pipeline(t, 'health', false, { trigger: 'promote', mergeBranch: 'dev', mergeCommit: promoted });
  assert.equal(result.status, 'failed');
  assert.ok(calls.some(call => call.kind === 'command' && call.cmd.startsWith('git push --dry-run')));
  assert.equal(calls.some(call => call.kind === 'command' && call.cmd.startsWith('git push "')), false);
  assert.equal(calls.some(call => call.kind === 'activate'), false);
});

test('a shared-branch promotion moves production to the tested commit and pushes nothing', async t => {
  const { calls, result } = await pipeline(t, undefined, false, { trigger: 'promote', commitSha: promoted }, true);
  assert.equal(result.status, 'success');
  const git = gitCommands(calls);
  assert.ok(git.includes('git checkout --no-overwrite-ignore "' + promoted + '"'));
  assert.equal(git.some(cmd => cmd.startsWith('git push')), false);
  assert.equal(git.some(cmd => cmd.startsWith('git merge "')), false);
  assert.match(result.log, /Promoting bbbbbbb, the commit staging is running/);
});

test('a shared-branch promotion is refused when production already includes the staging commit', async t => {
  const { calls, result } = await pipeline(t, undefined, false, { trigger: 'promote', commitSha: promoted });
  assert.equal(result.status, 'failed');
  assert.match(result.log, /already includes the commit staging is running/);
  assert.equal(calls.some(call => call.kind === 'build-command'), false);
  assert.equal(calls.some(call => call.kind === 'activate'), false);
});

test('known vulnerabilities fail before installation or building, with branch and commit already recorded', async t => {
  const { calls, result } = await pipeline(t, 'audit');
  assert.equal(result.status, 'failed');
  assert.ok(!calls.some(call => call.kind === 'install' || call.kind === 'cache-hit'));
  assert.ok(!calls.some(call => call.kind === 'build-command' && call.cmd === 'npm run build'));
  const admission = calls.find(call => call.kind === 'query' && call.sql.includes('INSERT INTO deployments'));
  assert.equal(admission.values[3], 'main');
  const commitIndex = calls.findIndex(call => call.kind === 'query' && call.sql.includes('SET commit_sha'));
  const auditIndex = calls.findIndex(call => call.kind === 'build-command' && call.cmd.startsWith('npm audit'));
  assert.ok(commitIndex >= 0 && commitIndex < auditIndex);
});

const securityStatuses = calls => calls.filter(call => call.kind === 'query' && call.sql.includes('SET security_status')).map(call => call.sql.includes("'overridden'") ? 'overridden' : call.sql.includes("'not_applicable'") ? 'not_applicable' : call.values[0]);

test('an administrator can deploy one release past the security gate; findings are still logged and the release is marked', async t => {
  const { calls, result } = await pipeline(t, 'audit', false, { trigger: 'manual', acceptSecurityRisk: { reason: 'Launch today; upgrade is booked for Monday' } });
  assert.equal(result.status, 'success');
  assert.ok(calls.some(call => call.kind === 'activate'));
  assert.equal(calls.filter(call => call.kind === 'build-command' && call.cmd.startsWith('npm audit')).length, 2, 'both audits still run');
  assert.match(result.log, /high: fixture-package/);
  assert.match(result.log, /OVERRIDE: Security gate blocked release: 1 high and 0 critical/);
  assert.match(result.log, /turned the security gate off for this deployment. Reason given: Launch today; upgrade is booked for Monday/);
  assert.match(result.log, /did NOT pass; released anyway under the override/);
  assert.doesNotMatch(result.log, /audit passed/);
  assert.deepEqual(securityStatuses(calls), ['overridden']);
});

test('an app whose gate is switched off deploys past findings without a per-deployment choice', async t => {
  const { calls, result } = await pipeline(t, 'final-audit', false, { trigger: 'webhook' }, false, 'Vendor fix expected next week');
  assert.equal(result.status, 'success');
  assert.match(result.log, /turned the security gate off for this app. Reason given: Vendor fix expected next week/);
  assert.deepEqual(securityStatuses(calls), ['overridden']);
});

test('a clean release is recorded as passed even while the gate is off', async t => {
  const { calls, result } = await pipeline(t, undefined, false, { trigger: 'manual' }, false, 'Vendor fix expected next week');
  assert.equal(result.status, 'success');
  assert.doesNotMatch(result.log, /OVERRIDE/);
  assert.deepEqual(securityStatuses(calls), ['passed']);
});

test('without an override the gate still blocks and the release is recorded as failed', async t => {
  const { calls, result } = await pipeline(t, 'audit');
  assert.equal(result.status, 'failed');
  assert.doesNotMatch(result.log, /OVERRIDE/);
  assert.deepEqual(securityStatuses(calls), [], 'nothing marks the release as passed or overridden');
});

test('cached deployments still audit, build separately, then activate on the assigned port', async t => {
  const { calls, result, candidate, root } = await pipeline(t, undefined, true);
  assert.equal(result.status, 'success');
  assert.equal(calls.some(call => call.kind === 'terminal-recovery'), false);
  const auditIndex = calls.findIndex(call => call.kind === 'build-command' && call.cmd.startsWith('npm audit'));
  const audits = calls.map((call, index) => call.kind === 'build-command' && call.cmd.startsWith('npm audit') ? index : -1).filter(index => index >= 0);
  const buildIndex = calls.findIndex(call => call.kind === 'build-command' && call.cmd === 'npm run build');
  assert.equal(audits.length, 2); assert.ok(audits[0] < buildIndex && audits[1] > buildIndex);
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
