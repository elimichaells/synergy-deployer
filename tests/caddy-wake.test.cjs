const assert = require('node:assert/strict');
const test = require('node:test');
const load = require('./server-module.cjs');

test('a sleeping staging site sends Caddy errors to the wake page; other sites are unchanged', () => {
  const caddy = load('lib/caddy.ts', { './exec': { runCommand: async () => ({ code: 0, output: '' }) } });
  const plain = caddy.renderCaddyBlock('staging.example.com', 4002);
  const asleep = caddy.renderCaddyBlock('staging.example.com', 4002, [], true);
  assert.ok(!plain.includes('handle_errors'));
  assert.match(asleep, /handle_errors \{\n\t\t@asleep expression \{err\.status_code\} == 502\n\t\thandle @asleep \{\n\t\t\trewrite \* \/api\/wake\?host=\{host\}\n\t\t\treverse_proxy 127\.0\.0\.1:4000/);
  assert.equal(asleep.replace(/\n\thandle_errors \{[\s\S]*?\n\t\}\n/, ''), plain, 'only the wake handler is added');
  assert.match(plain, /reverse_proxy 127\.0\.0\.1:4002 \{[\s\S]*?\n\n\tlog \{/, 'a site without sleep keeps its exact layout');
});
