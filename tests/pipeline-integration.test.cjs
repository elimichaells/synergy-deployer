const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const load = require('./server-module.cjs');

test('real PostgreSQL: idempotent migrations, grouped environment families and safe unlink', { skip: !process.env.MANAGER_TEST_ADMIN_URL }, async () => {
  const { Client, Pool } = require('pg');
  const admin = new Client({ connectionString: process.env.MANAGER_TEST_ADMIN_URL });
  const name = 'manager_pipeline_test_' + randomUUID().replaceAll('-', '');
  let pool; let created = false;
  try {
    await admin.connect();
    await admin.query('CREATE DATABASE "' + name + '" TEMPLATE template0'); created = true;
    const url = new URL(process.env.MANAGER_TEST_ADMIN_URL); url.pathname = '/' + name;
    pool = new Pool({ connectionString: url.toString(), max: 3 });
    await pool.query(`create table projects(id uuid primary key default gen_random_uuid(),name text,environment text,production_id uuid references projects(id),project_type text,port int,url text,default_branch text,updated_at timestamptz default now());
      create table deployments(id uuid primary key default gen_random_uuid(),project_id uuid references projects(id),status text,started_at timestamptz default now(),finished_at timestamptz);
      create table project_data_services(id uuid primary key default gen_random_uuid(),project_id uuid references projects(id));
      create table audit_logs(user_id uuid,action text,resource text,details jsonb);`);
    const db = { db: pool, query: (sql, values) => pool.query(sql, values) };
    class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
    const groups = load('lib/application-groups.ts', { '@/lib/db': db, '@/lib/api': { ApiError } });
    await groups.ensureApplicationGroupsSchema();
    const schema = load('lib/deployment-schema.ts', { '@/lib/db': db });
    await schema.ensureDeploymentSchema();
    await load('lib/deployment-schema.ts', { '@/lib/db': db }).ensureDeploymentSchema();
    const backend = (await pool.query("insert into projects(name,environment,project_type,port,default_branch) values('Fixture API','production','go',39171,'main') returning id")).rows[0].id;
    const frontend = (await pool.query("insert into projects(name,environment,project_type,port,default_branch) values('Fixture Web','production','angular',39172,'main') returning id")).rows[0].id;
    await pool.query("insert into projects(name,environment,production_id,project_type,port,default_branch) values('Fixture API staging','staging',$1,'go',40171,'staging')", [backend]);
    await groups.updateApplicationGroup(backend, { relatedProjectId: frontend, role: 'backend', relatedRole: 'frontend' });
    const snapshot = await groups.relatedApplications(frontend);
    assert.equal(snapshot.members.length, 3);
    assert.equal(snapshot.members.filter(member => member.component_role === 'backend').length, 2);
    assert.deepEqual(snapshot.members.map(member => member.port).sort(), [39171, 39172, 40171]);
    await groups.updateApplicationGroup(backend, { unlink: true });
    assert.equal((await groups.relatedApplications(frontend)).members.length, 1);
    const detached = await groups.relatedApplications(backend);
    assert.equal(detached.application_group_id, null);
    assert.ok(detached.candidates.some(item => item.id === frontend));
    assert.equal((await pool.query('select count(*)::int as n from projects')).rows[0].n, 3);
  } finally {
    if (pool) await pool.end();
    if (created) { assert.match(name, /^manager_pipeline_test_[a-f0-9]{32}$/); await admin.query('DROP DATABASE "' + name + '"'); }
    await admin.end();
  }
});

test('real npm: fresh installation, verified reuse, and a fresh audit on each candidate', { skip: process.env.MANAGER_TEST_NPM !== '1', timeout: 180000 }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-real-npm-test-'));
  t.after(async () => { assert.ok(base.startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(base, { recursive: true, force: true, maxRetries: 3 }); });
  const { runCommand } = require('../lib/exec.ts');
  const { installWithDependencyCache, assertAuditPassed } = require('../lib/deployment-cache.ts');
  const first = path.join(base, 'one'); const second = path.join(base, 'two');
  await fs.mkdir(first); await fs.mkdir(second);
  await fs.writeFile(path.join(first, 'package.json'), JSON.stringify({ name: 'manager-isolated-fixture', version: '1.0.0', private: true, dependencies: { 'is-number': '7.0.0' } }));
  const env = { NODE_ENV: 'development', npm_config_audit: 'false' };
  const prepared = await runCommand('npm install --package-lock-only --ignore-scripts --no-audit --no-fund', first, 60000, undefined, env, false);
  assert.equal(prepared.code, 0, 'Fixture lockfile generation must succeed');
  for (const file of ['package.json', 'package-lock.json']) await fs.copyFile(path.join(first, file), path.join(second, file));
  let installations = 0; const messages = [];
  for (const root of [first, second]) {
    const inspect = command => runCommand(command, root, 60000, undefined, env, false);
    const result = await installWithDependencyCache({ root, cacheRoot: path.join(base, 'cache'), command: 'npm ci --include=dev', env, inspect,
      execute: command => { installations++; return inspect(command); }, append: message => messages.push(message), checkCancelled() {} });
    assert.equal(result.code, 0);
    assertAuditPassed(await inspect('npm audit --json --package-lock-only --omit=dev --audit-level=high'), 'production dependencies');
  }
  assert.equal(installations, 1, 'Second candidate must reuse the verified dependency snapshot');
  assert.ok(messages.some(message => message.includes('Verified cache hit')));
});

test('real Windows PM2: live build, directory activation and failed-health rollback', { skip: process.env.MANAGER_TEST_PM2 !== '1', timeout: 240000 }, async () => {
  const { runCommand } = require('../lib/exec.ts');
  const { DeploymentRelease, sourceFingerprint } = require('../lib/deployment-release.ts');
  const { runDeploymentCommand } = require('../lib/deployment-command.ts');
  const net = require('node:net');
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'manager-pm2-test-'));
  const source = path.join(base, 'source'); const root = path.join(base, 'live');
  const name = 'manager-fixture-' + randomUUID().slice(0, 8);
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const cli = async (command, cwd = base, env = {}) => {
    const result = await runCommand(command, cwd, 60000, undefined, env, false);
    if (result.code) throw new Error('Fixture command failed: ' + command.split(' ')[0]);
    return result;
  };
  const httpBody = async () => (await fetch('http://127.0.0.1:' + port, { signal: AbortSignal.timeout(2000) })).text();
  const serve = text => `require('node:http').createServer((req,res)=>res.end('${text}')).listen(process.env.PORT,'127.0.0.1');`;
  let deployment = 0; let expected = 'old'; let observedLiveBuilds = 0;
  try {
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'index.js'), serve('old'));
    await fs.writeFile(path.join(source, 'build.js'), 'setTimeout(()=>console.log("fixture build completed"),800);');
    await fs.writeFile(path.join(source, '.gitignore'), '.env\nnode_modules/\n');
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'manager-pm2-fixture', version: '1.0.0', private: true, scripts: { build: 'node build.js' } }));
    await cli('npm install --package-lock-only --no-audit --no-fund', source);
    await cli('git init -b main', source);
    await cli('git add .', source);
    await cli('git -c user.name=Fixture -c user.email=fixture@example.test commit -m fixture-old', source);
    await cli(`git clone "${source}" "${root}"`);
    await cli(`pm2 start "${path.join(root, 'index.js')}" --name "${name}"`, root, { PORT: String(port) });
    for (let i = 0; i < 30; i++) { try { if (await httpBody() === 'old') break; } catch {} await new Promise(resolve => setTimeout(resolve, 200)); }
    assert.equal(await httpBody(), 'old');
    const query = async sql => ({ rows: sql.includes('INSERT INTO deployments') ? [{ id: 'fixture-' + (++deployment) }] : [] });
    const api = load('lib/deploy.ts', {
      '@/lib/db': { query }, '@/lib/exec': { runCommand }, '@/lib/github-connections': { getGitHubConnectionToken: async () => null },
      '@/lib/project-types': require('../lib/project-types.ts'), '@/lib/notify': { notifyDeploy: async () => {} },
      '@/lib/project-databases': { getProjectDatabaseEnv: async () => ({}) }, '@/lib/data-services': { getProjectDataServiceEnv: async () => ({}) },
      '@/lib/runtimes': { projectRuntimeEnvironment: () => ({}) }, '@/lib/deployment-health': require('../lib/deployment-health.ts'),
      '@/lib/deployment-command': { runDeploymentCommand: async (...args) => {
        if (args[0] === 'npm run build') { assert.equal(await httpBody(), expected); observedLiveBuilds++; }
        const result = await runDeploymentCommand(...args);
        if (args[0] === 'npm run build') assert.equal(await httpBody(), expected);
        return result;
      } },
      '@/lib/deployment-go': require('../lib/deployment-go.ts'), '@/lib/deployment-git': require('../lib/deployment-git.ts'),
      '@/lib/deployment-preparation': require('../lib/deployment-preparation.ts'), '@/lib/deployment-release': { DeploymentRelease, sourceFingerprint },
      '@/lib/deployment-runtime': require('../lib/deployment-runtime.ts'), '@/lib/deployment-processes': require('../lib/deployment-processes.ts'),
      '@/lib/deployment-terminals': require('../lib/deployment-terminals.ts'),
      '@/lib/deployment-locks': require('../lib/deployment-locks.ts'),
      '@/lib/deployment-cache': require('../lib/deployment-cache.ts'), '@/lib/deployment-capacity': { withInstallationSlot: work => work() },
      '@/lib/deployment-schema': { ensureDeploymentSchema: async () => {} }, '@/lib/deployment-activation': { beginReleaseActivation: async () => {} },
      '@/lib/ports': { allocateTemporaryPort: async () => port + 1 },
      '@/lib/caddy': { updateCaddyDomainsStrict: async () => {} },
      '@/lib/project-setup': { assertProjectSetupComplete: async () => {} }, '@/lib/project-operation': { acquireProjectOperation: async () => async () => {} },
    });
    const project = { id: randomUUID(), name, repo_url: source, default_branch: 'main', root_path: root, project_type: 'node',
      install_cmd: null, build_cmd: 'npm run build', start_cmd: 'node index.js', pm2_name: name, port };
    await fs.writeFile(path.join(source, 'index.js'), serve('new'));
    await cli('git add index.js', source);
    await cli('git -c user.name=Fixture -c user.email=fixture@example.test commit -m fixture-new', source);
    const success = await api.runDeploy({ ...project }, { trigger: 'manual' });
    assert.equal(success.status, 'success', success.log);
    assert.equal(await httpBody(), 'new');
    expected = 'new';
    // Boot successfully during preflight, then fail only at the live path so
    // this exercises rollback after real activation, not an early rejection.
    await fs.writeFile(path.join(source, 'index.js'), `if (process.cwd().toLowerCase() === ${JSON.stringify(root.toLowerCase())}) process.exit(1); else { ${serve('preview-only')} }`);
    await cli('git add index.js', source);
    await cli('git -c user.name=Fixture -c user.email=fixture@example.test commit -m fixture-broken', source);
    const failed = await api.runDeploy({ ...project }, { trigger: 'manual' });
    assert.equal(failed.status, 'failed');
    assert.match(failed.log, /Previous release health verified/);
    assert.equal(await httpBody(), 'new');
    assert.equal(observedLiveBuilds, 2);
  } finally {
    await runCommand(`pm2 delete "${name}"`, undefined, 30000, undefined, undefined, false);
    await runCommand('pm2 save', undefined, 30000, undefined, undefined, false);
    assert.ok(base.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
});
