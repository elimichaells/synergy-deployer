const assert = require('node:assert/strict');
const test = require('node:test');
const load = require('./server-module.cjs');

class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }

test('application pins are stored per user and can be removed', async () => {
  const calls = [];
  const query = async (sql, values) => {
    calls.push({ sql, values });
    if (sql.startsWith('select id from projects')) return { rows: [{ id: 'project' }] };
    return { rows: [] };
  };
  const pins = load('lib/project-pins.ts', { '@/lib/db': { query }, '@/lib/api': { ApiError } });
  await pins.setProjectPinned('user-one', 'project-one', true);
  await pins.setProjectPinned('user-one', 'project-one', false);
  assert.ok(calls.some(call => call.sql.startsWith('insert into project_pins') && call.values[0] === 'user-one'));
  assert.ok(calls.some(call => call.sql.startsWith('delete from project_pins') && call.values[1] === 'project-one'));
});

test('pinning a missing application is rejected', async () => {
  const query = async sql => ({ rows: sql.startsWith('select id from projects') ? [] : [] });
  const pins = load('lib/project-pins.ts', { '@/lib/db': { query }, '@/lib/api': { ApiError } });
  await assert.rejects(pins.setProjectPinned('user-one', 'missing', true), error => error.status === 404);
});
