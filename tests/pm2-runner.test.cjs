const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function fixture() {
  const child = new EventEmitter(); child.pid = 1234;
  const process = new EventEmitter();
  process.platform = 'win32'; process.env = { MANAGER_START_CMD: 'php artisan serve', __NEXT_PROCESSED_ENV: 'true' };
  process.cwd = () => 'C:\\fixture';
  const exits = []; process.exit = code => exits.push(code);
  const kills = []; let options;
  vm.runInNewContext(fs.readFileSync(require.resolve('../scripts/pm2-runner.js'), 'utf8'), {
    process, console,
    require: () => ({ spawn: (_command, config) => { options = config; return child; }, execFile: (...args) => kills.push(args) }),
  });
  return { process, child, exits, kills, options };
}

test('PM2 runner waits for Windows tree cleanup before acknowledging IPC shutdown', () => {
  const { process, child, exits, kills, options } = fixture();
  assert.equal(options.env.__NEXT_PROCESSED_ENV, undefined);
  process.emit('message', 'unrelated'); assert.equal(kills.length, 0);
  process.emit('message', 'shutdown');
  process.emit('SIGINT'); assert.equal(kills.length, 1, 'Shutdown is idempotent');
  assert.deepEqual(Array.from(kills[0][1], String), ['/T', '/F', '/PID', '1234']);
  child.emit('exit', 1, null); assert.equal(exits.length, 0);
  kills[0][3](null); assert.deepEqual(exits, [0]);
});

test('PM2 runner waits for child exit when tree cleanup completes first', () => {
  const { process, child, exits, kills } = fixture();
  process.emit('SIGTERM'); kills[0][3](null);
  assert.equal(exits.length, 0);
  child.emit('exit', 1, null); assert.deepEqual(exits, [0]);
});

test('PM2 runner preserves ordinary runtime failures', () => {
  const { child, exits, kills } = fixture();
  child.emit('exit', 7, null);
  assert.deepEqual(exits, [7]); assert.equal(kills.length, 0);
});
