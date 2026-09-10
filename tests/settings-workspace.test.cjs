const test = require('node:test');
const assert = require('node:assert/strict');
const { EDITABLE_SETTINGS, SETTINGS_SECTIONS, settingsSection, settingsForm, settingsChanges, validateSettingsSection, runtimeCategory } = require('../lib/settings-workspace.ts');
const initial = { ...EDITABLE_SETTINGS, PRODUCTION_PATH: 'C:\\apps\\production', STAGING_PATH: 'C:\\apps\\staging', LOGS_PATH: 'C:\\logs', CADDY_PATH: 'C:\\caddy', BACKUP_DIR: 'C:\\backups', PG_BIN_PATH: 'C:\\postgres\\bin' };

test('settings sections have stable deep links and unknown sections fall back safely', () => {
  assert.equal(SETTINGS_SECTIONS.length, 6);
  for (const section of SETTINGS_SECTIONS) assert.equal(settingsSection(section.id), section.id);
  assert.equal(settingsSection(null), 'general');
  assert.equal(settingsSection('unsupported'), 'general');
});
test('settings forms exclude legacy tokens, internal metadata and unexpected fields', () => {
  const form = settingsForm({ ...initial, GITHUB_TOKEN: 'private-legacy-token', BACKUP_LAST_RUN: 'internal', extra: 'value' });
  assert.deepEqual(form, initial);
  assert.throws(() => settingsForm({}), /Incomplete/);
  assert.throws(() => settingsForm([]), /Invalid/);
});
test('saving one settings section only sends changed keys from that section', () => {
  const draft = { ...initial, PRODUCTION_PATH: 'D:\\production', BACKUP_RETENTION_DAYS: '30', NOTIFY_WEBHOOK_URL: 'https://example.test/notify' };
  assert.deepEqual(settingsChanges('general', initial, draft), { PRODUCTION_PATH: 'D:\\production' });
  assert.deepEqual(settingsChanges('notifications', initial, draft), { NOTIFY_WEBHOOK_URL: 'https://example.test/notify' });
  assert.deepEqual(settingsChanges('backups', initial, draft), { BACKUP_RETENTION_DAYS: '30' });
  assert.deepEqual(settingsChanges('integrations', initial, draft), {});
  assert.deepEqual(settingsChanges('runtimes', initial, draft), {});
  assert.deepEqual(settingsChanges('access', initial, draft), {});
  assert.deepEqual(settingsChanges('general', initial, initial), {});
});
test('settings validation handles paths, retention and notification endpoints without blocking other sections', () => {
  assert.equal(validateSettingsSection('general', initial), null);
  assert.match(validateSettingsSection('general', { ...initial, LOGS_PATH: ' ' }), /directory/);
  for (const value of ['0', '-2', '1.5', 'NaN', '3651']) assert.match(validateSettingsSection('backups', { ...initial, BACKUP_RETENTION_DAYS: value }), /whole number/);
  for (const value of ['', 'https://example.test/notify', 'http://127.0.0.1:8000/notify']) assert.equal(validateSettingsSection('notifications', { ...initial, NOTIFY_WEBHOOK_URL: value }), null);
  for (const value of ['invalid', 'javascript:alert(1)', 'https://name:password@example.test/notify']) assert.ok(validateSettingsSection('notifications', { ...initial, NOTIFY_WEBHOOK_URL: value }));
  assert.equal(validateSettingsSection('general', { ...initial, BACKUP_RETENTION_DAYS: '-5' }), null);
});
test('runtime categories keep language toolchains, database providers and host tools distinct', () => {
  for (const id of ['node', 'php', 'go', 'angular', 'composer']) assert.equal(runtimeCategory(id), 'languages');
  for (const id of ['postgresql', 'mysql', 'mariadb', 'sqlserver', 'mongodb', 'redis']) assert.equal(runtimeCategory(id), 'databases');
  for (const id of ['git', 'caddy', 'sling', 'phpmyadmin', 'future-tool']) assert.equal(runtimeCategory(id), 'tools');
});
