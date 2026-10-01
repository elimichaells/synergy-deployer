const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const load = require('./server-module.cjs');

test('manager exception configuration validates entries and fails closed on read errors', () => {
  const entry = { projectId: 'one', package: 'sharp', advisory: 'GHSA-rgj7-g3m4-5g8c', reason: 'Reviewed mitigation', expiresAt: '2026-10-02T00:00:00Z' };
  const policy = (readFileSync) => load('lib/deployment-cache.ts', { fs: { ...fs, readFileSync }, './deployment-preparation': {} }).loadAuditExceptions;
  assert.deepEqual(policy(() => JSON.stringify([entry]))(), [entry]);
  assert.deepEqual(policy(() => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); })(), []);
  assert.throws(policy(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }), /blocked/);
  for (const value of ['invalid', '{}', '[null]', JSON.stringify([{ ...entry, reason: 'injected\nlog' }]),
    JSON.stringify([{ ...entry, expiresAt: 'tomorrow' }]), JSON.stringify([{ ...entry, advisory: '*' }])]) {
    assert.throws(policy(() => value), /blocked/);
  }
});
