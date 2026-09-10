const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const load = require('./server-module.cjs');
const policy = require('../lib/data-removal-policy.ts');
const { ApiError, jsonError } = load('lib/api.ts', {});

test('only finished migrations are removable, after worker cleanup', () => {
  for (const status of ['queued', 'running', 'validating', 'unknown']) assert.ok(policy.migrationRemovalReason(status));
  for (const status of ['succeeded', 'failed', 'cancelled', 'interrupted', 'activated']) {
    assert.equal(policy.migrationRemovalReason(status), null);
    assert.match(policy.migrationRemovalReason(status, true), /stopping or cleaning up/);
  }
});

test('resource removal explains primary, deployment, backup and history protections', () => {
  const eligible = { application_primary: false, deployment_active: false, backup_status: null, migration_active: false, migration_count: 0 };
  assert.equal(policy.dataServiceRemovalReason(eligible), null);
  assert.match(policy.dataServiceRemovalReason({ ...eligible, application_primary: true }), /application database/);
  assert.match(policy.dataServiceRemovalReason({ ...eligible, deployment_active: true }), /deployment/);
  assert.match(policy.dataServiceRemovalReason({ ...eligible, backup_status: 'running' }), /backup/);
  assert.match(policy.dataServiceRemovalReason({ ...eligible, migration_active: true, migration_count: 1 }), /active migration/);
  assert.match(policy.dataServiceRemovalReason({ ...eligible, migration_count: 2 }), /2 linked migration history records/);
  assert.equal(policy.dataServiceRemovalReason({ ...eligible, backup_status: 'success' }), null);
});

test('migration DELETE enforces administrator role and retains a nonsecret audit record', async () => {
  let role = 'viewer'; let deleted = 0; const audits = [];
  const { requireRole } = load('lib/rbac.ts', { './api': { ApiError } });
  const route = load('app/api/data/migrations/[id]/route.ts', {
    '@/lib/api': { ApiError, jsonError }, '@/lib/auth': { getSessionFromCookie: async () => role ? { id: 'user', role } : null },
    '@/lib/rbac': { requireRole }, '@/lib/audit': { audit: async (...args) => audits.push(args) },
    '@/lib/data-migrations': { deleteDataMigration: async () => { deleted++; return { project_id: 'project', source_service_id: 'source', target_service_id: 'target', status: 'failed' }; } },
  });
  const context = { params: Promise.resolve({ id: 'job' }) };
  for (role of [null, 'viewer', 'operator']) {
    const response = await route.DELETE(new Request('http://fixture/api/data/migrations/job', { method: 'DELETE' }), context);
    assert.equal(response.status, role ? 403 : 401);
  }
  assert.equal(deleted, 0);
  role = 'admin';
  assert.equal((await route.DELETE(new Request('http://fixture'), context)).status, 200);
  assert.equal(deleted, 1);
  assert.deepEqual(audits[0], ['user', 'data.migration.delete', 'project', { migrationId: 'job', sourceServiceId: 'source', targetServiceId: 'target', status: 'failed' }]);
});

test('resource DELETE denies non-admin users before any mutation', async () => {
  let role = 'viewer'; let deleted = 0;
  const { requireRole } = load('lib/rbac.ts', { './api': { ApiError } });
  const route = load('app/api/sites/[id]/data-services/[serviceId]/route.ts', {
    '@/lib/api': { jsonError }, '@/lib/auth': { getSessionFromCookie: async () => role ? { id: 'user', role } : null },
    '@/lib/rbac': { requireRole }, '@/lib/audit': { audit: async () => {} },
    '@/lib/data-services': { detachProjectDataService: async () => { deleted++; } },
  });
  const context = { params: Promise.resolve({ id: 'project', serviceId: 'service' }) };
  for (role of [null, 'viewer', 'operator']) assert.equal((await route.DELETE(new Request('http://fixture'), context)).status, role ? 403 : 401);
  assert.equal(deleted, 0);
  role = 'admin';
  assert.equal((await route.DELETE(new Request('http://fixture'), context)).status, 200);
  assert.equal(deleted, 1);
});

test('real PostgreSQL: removal eligibility, foreign keys and concurrent operations', { skip: !process.env.MANAGER_TEST_ADMIN_URL, timeout: 60000 }, async () => {
  const { Client, Pool } = require('pg');
  const admin = new Client({ connectionString: process.env.MANAGER_TEST_ADMIN_URL });
  const name = 'manager_removal_test_' + randomUUID().replaceAll('-', '');
  let pool; let created = false;
  try {
    await admin.connect();
    await admin.query('CREATE DATABASE "' + name + '" TEMPLATE template0'); created = true;
    const url = new URL(process.env.MANAGER_TEST_ADMIN_URL); url.pathname = '/' + name;
    pool = new Pool({ connectionString: url.toString(), max: 8 });
    await pool.query(`create table projects(id uuid primary key default gen_random_uuid(),name text,environment text);
      create table users(id uuid primary key);
      create type deployment_status as enum ('queued','running','success','failed');
      create table deployments(id uuid primary key default gen_random_uuid(),project_id uuid references projects(id),status deployment_status);
      create table fixture_application_data(id int primary key, value text);
      insert into fixture_application_data values(1,'Must remain untouched');`);
    const database = { db: pool, query: (sql, params) => pool.query(sql, params) };
    const projectOperation = load('lib/project-operation.ts', { '@/lib/db': database, '@/lib/api': { ApiError } });
    const migrations = load('lib/data-migrations.ts', {
      '@/lib/api': { ApiError }, '@/lib/db': database, '@/lib/exec': {}, '@/lib/secret-crypto': {}, '@/lib/data-removal-policy': policy,
    });
    const services = load('lib/data-services.ts', {
      '@/lib/api': { ApiError }, '@/lib/db': database, '@/lib/secret-crypto': {}, '@/lib/data-removal-policy': policy,
      '@/lib/project-operation': projectOperation, '@/lib/data-migrations': migrations,
    });
    await services.ensureDataServicesSchema(); await migrations.ensureDataMigrationSchema();
    const project = (await pool.query("insert into projects(name,environment) values('Fixture','production') returning id")).rows[0].id;
    const connection = (await pool.query("insert into data_connections(name,provider,host,port) values('Fixture','postgresql','never-connect.example.test',5432) returning id")).rows[0].id;
    const addService = async primary => (await pool.query("insert into project_data_services(project_id,connection_id,name,database_name,env_prefix,application_primary) values($1,$2,$3,'fixture_data',$3,$4) returning id", [project, connection, randomUUID(), primary])).rows[0].id;
    const source = await addService(false); const target = await addService(true);
    const addJob = async status => (await pool.query('insert into data_migration_jobs(project_id,source_service_id,target_service_id,status) values($1,$2,$3,$4) returning id', [project, source, target, status])).rows[0].id;
    const conflict = fn => assert.rejects(fn, error => error.status === 409);

    await conflict(() => services.detachProjectDataService(project, target));
    await assert.rejects(() => services.detachProjectDataService(randomUUID(), source), error => error.status === 404);
    await assert.rejects(() => migrations.deleteDataMigration(randomUUID()), error => error.status === 404);

    for (const status of ['queued', 'running', 'validating']) {
      const id = await addJob(status);
      await conflict(() => migrations.deleteDataMigration(id));
      await conflict(() => services.detachProjectDataService(project, source));
      await pool.query("update data_migration_jobs set status='cancelled' where id=$1", [id]);
      await migrations.deleteDataMigration(id);
    }
    for (const status of ['failed', 'interrupted', 'cancelled', 'succeeded', 'activated']) {
      const id = await addJob(status);
      const listed = await services.listProjectDataServices(project);
      assert.match(listed.find(s => s.id === source).removal_blocked_reason, /1 linked migration history record/);
      assert.equal((await migrations.listDataMigrationJobs(project))[0].removal_blocked_reason, null);
      await conflict(() => services.detachProjectDataService(project, source));
      const record = await migrations.deleteDataMigration(id);
      assert.equal(record.status, status);
      assert.equal((await pool.query('select application_primary from project_data_services where id=$1', [target])).rows[0].application_primary, true);
      assert.equal((await pool.query('select count(*)::int as n from project_data_services')).rows[0].n, 2);
    }

    // Terminal status is not sufficient while a cancelled worker still owns the execution lock.
    const cancelled = await addJob('cancelled'); const worker = await pool.connect();
    try {
      await worker.query("select pg_advisory_lock(hashtext('manager-data-migration'),hashtext($1))", [cancelled]);
      await conflict(() => migrations.deleteDataMigration(cancelled));
    } finally { await worker.query("select pg_advisory_unlock(hashtext('manager-data-migration'),hashtext($1))", [cancelled]); worker.release(); }
    await migrations.deleteDataMigration(cancelled);

    const deployment = (await pool.query("insert into deployments(project_id,status) values($1,'running') returning id", [project])).rows[0].id;
    assert.match((await services.listProjectDataServices(project)).find(s => s.id === source).removal_blocked_reason, /deployment/);
    await conflict(() => services.detachProjectDataService(project, source));
    await pool.query("update deployments set status='success' where id=$1", [deployment]);
    const release = await projectOperation.acquireProjectOperation(project);
    try { await conflict(() => services.detachProjectDataService(project, source)); } finally { await release(); }

    const schedule = (await pool.query("insert into data_service_backup_schedules(service_id,frequency,last_status) values($1,'daily','running') returning id", [source])).rows[0].id;
    assert.match((await services.listProjectDataServices(project)).find(s => s.id === source).removal_blocked_reason, /backup/);
    await conflict(() => services.detachProjectDataService(project, source));
    await pool.query("update data_service_backup_schedules set last_status='success' where id=$1", [schedule]);

    // A backup claim committed while detach waits must be rechecked, never cascaded away.
    const backup = await pool.connect();
    try {
      await backup.query('begin');
      await backup.query("update data_service_backup_schedules set last_status='running' where id=$1", [schedule]);
      const removing = conflict(() => services.detachProjectDataService(project, source));
      await backup.query('commit');
      await removing;
    } finally { backup.release(); }
    await pool.query("update data_service_backup_schedules set last_status='success' where id=$1", [schedule]);
    assert.equal((await services.listProjectDataServices(project)).find(s => s.id === source).removal_blocked_reason, null);
    await services.detachProjectDataService(project, source);
    assert.equal((await pool.query('select count(*)::int as n from data_service_backup_schedules where id=$1', [schedule])).rows[0].n, 0);
    assert.equal((await pool.query('select count(*)::int as n from data_connections')).rows[0].n, 1);
    assert.equal((await pool.query('select count(*)::int as n from project_data_services')).rows[0].n, 1);
    assert.equal((await pool.query('select value from fixture_application_data')).rows[0].value, 'Must remain untouched');
  } finally {
    if (pool) await pool.end();
    if (created) { assert.match(name, /^manager_removal_test_[a-f0-9]{32}$/); await admin.query('DROP DATABASE "' + name + '"'); }
    await admin.end();
  }
});
