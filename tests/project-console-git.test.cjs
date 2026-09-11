const assert = require('node:assert/strict');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const load = require('./server-module.cjs');
class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
const token = 'github_fixture_secret_123456';
const basic = Buffer.from('x-access-token:' + token).toString('base64');
const app = { root_path: process.cwd(), repo_url: 'https://github.com/example/private.git', github_connection_id: 'selected-connection' };
function gitModule(getToken = async () => token) {
  return load('lib/project-console-git.ts', { '@/lib/api': { ApiError }, '@/lib/github-connections': { getGitHubConnectionToken: getToken } });
}

test('only standalone Git network commands can receive the selected connection', async () => {
  const calls = [];
  const api = gitModule(async id => { calls.push(id); return token; });
  for (const command of ['git status', 'git config --list', 'set', 'npm run build', 'powershell git fetch', 'git -c alias.test=fetch test']) {
    assert.equal(await api.prepareConsoleGit(command, app), null);
  }
  assert.equal(calls.length, 0);
  const prepared = await api.prepareConsoleGit('git fetch origin', app);
  assert.deepEqual(calls, ['selected-connection']);
  assert.deepEqual(prepared.command.args, ['fetch', 'origin']);
  assert.ok(require('node:path').isAbsolute(prepared.command.file));
  assert.ok(!JSON.stringify(prepared.command).includes(token));
  assert.deepEqual(api.consoleGitArguments('git.exe push origin "HEAD:refs/heads/my-branch"'), ['push', 'origin', 'HEAD:refs/heads/my-branch']);
  assert.deepEqual(api.consoleGitArguments("git ls-remote origin 'refs/heads/*'"), ['ls-remote', 'origin', 'refs/heads/*']);
  for (const command of ['git fetch origin && set', 'git fetch origin | more', 'git fetch $env:REMOTE', 'git fetch %REMOTE%', 'git fetch origin; set', 'git fetch --upload-pack=evil origin', 'git push --receive-pack=evil origin', 'git push -eevil origin', 'git ls-remote -uevil origin', 'git fetch "origin']) {
    assert.throws(() => api.consoleGitArguments(command), error => error.status === 400, command);
  }
});

test('HTTPS GitHub credentials are scoped to one repository using actual Git URL matching', async () => {
  const api = gitModule();
  assert.deepEqual(api.githubRepositoryUrls('https://old-user:old-password@github.com/example/private.git/'), ['https://github.com/example/private', 'https://github.com/example/private.git']);
  for (const url of ['http://github.com/example/private', 'https://github.com.evil.test/example/private', 'https://github.com:444/example/private', 'git@github.com:example/private.git', 'https://github.com/example/private/extra']) assert.deepEqual(api.githubRepositoryUrls(url), []);
  const prepared = await api.prepareConsoleGit('git fetch origin', app);
  const env = { ...process.env, ...prepared.env };
  const match = url => execFileSync(prepared.command.file, ['config', '--get-urlmatch', 'http.extraheader', url], { env, windowsHide: true, encoding: 'utf8' }).trim();
  for (const url of ['https://github.com/example/private', 'https://github.com/example/private.git', 'https://github.com/example/private.git/info/refs']) assert.equal(match(url), 'Authorization: Basic ' + basic);
  for (const url of ['https://github.com/example/another.git', 'https://github.com/example/private-other.git', 'https://example.com/example/private.git', 'http://github.com/example/private.git']) assert.equal(match(url), '');
  assert.equal(prepared.env.GIT_CONFIG_VALUE_0, ''); // Ignore stale OS credentials.
  assert.equal(prepared.env.GIT_CONFIG_VALUE_2, 'false'); // Do not forward auth through redirects.
  assert.ok(!Object.keys(prepared.env).some(key => /DATABASE|GITHUB_TOKEN|PATH/i.test(key)));
});

test('non-GitHub repositories do not retrieve a token; public repositories can work without one', async () => {
  let reads = 0;
  const api = gitModule(async () => { reads++; return null; });
  assert.equal(await api.prepareConsoleGit('git fetch origin', { ...app, repo_url: 'git@github.com:example/private.git' }), null);
  assert.equal(reads, 0);
  const prepared = await api.prepareConsoleGit('git fetch origin', app);
  assert.equal(prepared.authenticated, false);
  assert.deepEqual(prepared.env, {});
});

test('secret redaction survives every chunk boundary and redacts truncated credentials', () => {
  const { secretRedactor } = load('lib/exec.ts', {});
  for (const secret of [token, basic]) {
    for (let cut = 1; cut < secret.length; cut++) {
      let output = '';
      const redact = secretRedactor([token, basic], text => { output += text; });
      redact.write('before ' + secret.slice(0, cut));
      redact.write(secret.slice(cut) + ' after');
      redact.end();
      assert.equal(output, 'before [redacted] after');
    }
  }
  let output = '';
  const redact = secretRedactor([token], text => { output += text; });
  redact.write('truncated ' + token.slice(0, 10)); redact.end();
  assert.equal(output, 'truncated [redacted]');
});

test('direct Git execution retains cancellation and redacts both streams and retained output', async () => {
  let child, options, executable, args; const killed = [];
  const api = load('lib/exec.ts', { child_process: {
    spawn: (file, argv, opts) => {
      executable = file; args = argv; options = opts;
      child = new EventEmitter(); child.pid = 12345; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); return child;
    },
    execSync: command => killed.push(command),
  } });
  const controller = new AbortController(); let stream = '';
  const promise = api.runCommand({ file: 'git.exe', args: ['fetch', 'origin'] }, process.cwd(), 10000, text => { stream += text; }, { GIT_CONFIG_COUNT: '0' }, false, { signal: controller.signal, redact: [token, basic] });
  assert.equal(executable, 'git.exe'); assert.deepEqual(args, ['fetch', 'origin']); assert.equal(options.shell, false);
  assert.equal(options.env.GIT_TERMINAL_PROMPT, '0'); assert.equal(options.env.GCM_INTERACTIVE, 'never');
  child.stdout.emit('data', Buffer.from(token.slice(0, 12)));
  child.stderr.emit('data', Buffer.from('Authorization: Basic ' + basic));
  child.stdout.emit('data', Buffer.from(token.slice(12) + '\n'));
  controller.abort();
  const result = await promise;
  assert.equal(result.code, 1); assert.deepEqual(killed, ['taskkill /T /F /PID 12345']);
  assert.equal(result.output, stream); assert.ok(stream.includes('[redacted]')); assert.ok(!stream.includes(token)); assert.ok(!stream.includes(basic));
});

test('console route passes the selected project connection and releases the operation lock', async () => {
  const git = gitModule(); let run; let unlocks = 0;
  const api = load('app/api/sites/[id]/console/route.ts', {
    '@/lib/auth': { getSessionFromCookie: async () => ({ id: 'operator', role: 'operator' }) },
    '@/lib/rbac': { requireRole: () => {} }, '@/lib/api': { ApiError, jsonError: error => Response.json({ error: error.message }, { status: error.status || 500 }) },
    '@/lib/db': { query: async sql => ({ rows: sql.startsWith('select') ? [{ ...app, id: 'fixture' }] : [] }) },
    '@/lib/project-operation': { acquireProjectOperation: async () => async () => { unlocks++; } },
    '@/lib/project-console': { validateConsoleCommand: () => null, resolveConsoleWorkingDirectory: async root => root, readProjectEnvironment: () => { throw new Error('Git must not receive application secrets'); } },
    '@/lib/project-console-git': git, '@/lib/runtimes': {}, '@/lib/project-databases': {}, '@/lib/data-services': {},
    '@/lib/exec': { runCommand: async (...args) => { run = args; args[3]('fatal: Authentication failed\n'); return { code: 128, output: 'Authentication failed' }; } },
  });
  const response = await api.POST(new Request('http://localhost/console', { method: 'POST', body: JSON.stringify({ command: 'git fetch origin' }) }), { params: Promise.resolve({ id: 'fixture' }) });
  assert.equal(response.status, 200);
  const output = await response.text();
  assert.deepEqual(run[0].args, ['fetch', 'origin']); assert.equal(run[5], false); assert.deepEqual(run[6].redact, [token, basic]);
  assert.ok(output.includes('saved GitHub connection')); assert.ok(output.includes('Settings > Connections > GitHub accounts')); assert.ok(output.includes('code 128'));
  assert.ok(!output.includes(token)); assert.equal(unlocks, 1);
});
