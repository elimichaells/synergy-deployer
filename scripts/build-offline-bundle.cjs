// Runs on the connected Windows build machine only. Target setup never calls npm.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => index % 2 ? pairs : [...pairs, [value.replace(/^--/, ''), all[index + 1]]], []));
const source = path.resolve(args.source || '.');
const output = path.resolve(args.output || path.join(source, 'offline'));
const cache = path.resolve(args.cache || path.join(__dirname, '../packages/offline-cache'));
const lock = JSON.parse(fs.readFileSync(path.join(source, 'installer/offline/dependencies.lock.json')));
const quote = value => "'" + value.replaceAll("'", "''") + "'";
function run(file, argv, options = {}) {
  const result = spawnSync(file, argv, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${path.basename(file)} failed (${result.status})`);
}
function ps(script) {
  run(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+$env:PSModulePath; " + script, 'utf16le').toString('base64')]);
}
async function hash(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
function zip(directory, file) {
  ps(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${quote(directory)},${quote(file)},[IO.Compression.CompressionLevel]::Optimal,$false)`);
}
async function download(item) {
  const target = path.join(cache, item.file);
  if (fs.existsSync(target) && await hash(target) === item.sha256) return target;
  console.log(`Downloading pinned ${item.id} ${item.version} on the build machine...`);
  const response = await fetch(item.url, { signal: AbortSignal.timeout(600000) });
  if (!response.ok) throw Error(`Download failed for ${item.id}: HTTP ${response.status}`);
  const partial = target + '.partial';
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial));
  if (await hash(partial) !== item.sha256) throw Error(`Publisher artifact changed: SHA-256 mismatch for ${item.id}`);
  fs.renameSync(partial, target);
  return target;
}
async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Offline releases must be built on Windows x64');
  if (fs.existsSync(output)) throw Error('Use a new empty output path for the offline bundle');
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  const work = fs.mkdtempSync(path.join(cache, 'build-'));
  const artifacts = [];
  const roots = {};
  async function record(id, version, file, origin) {
    artifacts.push({ id, version, file: path.basename(file), sha256: await hash(file), bytes: fs.statSync(file).size, source: origin });
  }
  for (const item of lock.artifacts) {
    const downloaded = await download(item);
    if (item.authenticode) ps(`$s=Get-AuthenticodeSignature -LiteralPath ${quote(downloaded)}; if($s.Status -ne 'Valid'){throw 'Invalid publisher signature: ${item.id}'}`);
    if (['python', 'vcredist'].includes(item.id)) {
      const file = path.join(output, item.file);
      fs.copyFileSync(downloaded, file);
      await record(item.id, item.version, file, item.url);
      continue;
    }
    const cachedZip = path.join(cache, `normalized-v1-${item.id}-${item.sha256}.zip`);
    const cachedReceipt = cachedZip + '.json';
    const cachedHash = fs.existsSync(cachedReceipt) ? JSON.parse(fs.readFileSync(cachedReceipt)).sha256 : null;
    const cached = cachedHash && fs.existsSync(cachedZip) && await hash(cachedZip) === cachedHash;
    if (cached && item.id !== 'node') {
      const file = path.join(output, item.id + '.zip');
      fs.copyFileSync(cachedZip, file);
      await record(item.id, item.version, file, item.url);
      console.log('Reusing verified build cache', item.id);
      continue;
    }
    const unpacked = path.join(work, item.id);
    fs.mkdirSync(unpacked);
    if (item.id === 'composer') {
      fs.copyFileSync(downloaded, path.join(unpacked, 'composer.phar'));
      fs.writeFileSync(path.join(unpacked, 'composer.cmd'), '@echo off\r\nphp.exe "%~dp0composer.phar" %*\r\nexit /b %errorlevel%\r\n');
    } else {
      run(path.join(process.env.SystemRoot, 'System32/tar.exe'), ['-xf', downloaded, '-C', unpacked]);
    }
    const root = path.join(unpacked, item.root || '.');
    if (item.id === 'postgresql') {
      // Keep server/tools, extensions, documentation and licences. pgAdmin/Stack
      // Builder are unrelated GUI downloads and are not required by Manager.
      for (const name of ['pgAdmin 4', 'StackBuilder']) {
        const candidate = path.resolve(root, name);
        if (!candidate.startsWith(path.resolve(work) + path.sep)) throw Error('Unsafe build cleanup');
        fs.rmSync(candidate, { recursive: true, force: true });
      }
    }
    if (item.id === 'pgweb') {
      const exe = fs.readdirSync(root).find(name => /^pgweb(?:_windows_amd64)?(?:\.exe)?$/.test(name));
      if (!exe) throw Error('Pgweb executable missing');
      if (exe !== 'pgweb.exe') fs.renameSync(path.join(root, exe), path.join(root, 'pgweb.exe'));
    }
    roots[item.id] = root;
    const file = path.join(output, item.id + '.zip');
    console.log('Packing', item.id);
    if (cached) fs.copyFileSync(cachedZip, file);
    else {
      zip(root, file);
      fs.copyFileSync(file, cachedZip);
      fs.writeFileSync(cachedReceipt, JSON.stringify({ sha256: await hash(cachedZip) }));
    }
    await record(item.id, item.version, file, item.url);
  }
  const node = path.join(roots.node, 'node.exe');
  const npm = path.join(roots.node, 'node_modules/npm/bin/npm-cli.js');
  const env = { ...process.env, MANAGER_PREVIEW: '1', NEXT_TELEMETRY_DISABLED: '1' };
  for (const key of Object.keys(env)) if (/^(DATABASE_|ADMIN_|APP_POSTGRES_|MANAGER_INSTALL_|JWT_SECRET|MANAGER_ENCRYPTION_KEY)/i.test(key)) delete env[key];
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'Path';
  env[pathKey] = roots.node + path.delimiter + env[pathKey];
  function npmRun(argv, cwd) { run(node, [npm, ...argv], { cwd, env }); }
  const pm2 = path.join(work, 'pm2');
  fs.mkdirSync(pm2);
  for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(source, 'installer/offline/pm2', name), path.join(pm2, name));
  npmRun(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], pm2);
  if (JSON.parse(fs.readFileSync(path.join(pm2, 'node_modules/pm2/package.json'))).version !== lock.pm2Version)
    throw Error('PM2 package lock does not match the offline catalog');
  fs.writeFileSync(path.join(pm2, 'pm2.cmd'), '@echo off\r\nnode.exe "%~dp0node_modules\\pm2\\bin\\pm2" %*\r\nexit /b %errorlevel%\r\n');
  const pm2Zip = path.join(output, 'pm2.zip');
  zip(pm2, pm2Zip);
  await record('pm2', lock.pm2Version, pm2Zip, 'installer/offline/pm2/package-lock.json');
  // Never read an existing production .next/node_modules or the host .env files.
  const app = path.join(work, 'application-build');
  fs.cpSync(source, app, { recursive: true, filter: file => {
    const relative = path.relative(source, file).replaceAll('\\', '/');
    return !relative.split('/').some(part => ['.git','node_modules','.next','packages','offline','bin','obj'].includes(part)) && !/(^|\/)\.env($|\.)/.test(relative);
  } });
  fs.writeFileSync(path.join(app, '.eslintrc.json'), JSON.stringify({ root: true, extends: 'next/core-web-vitals' }));
  npmRun(['ci', '--no-audit', '--no-fund'], app);
  npmRun(['run', 'build'], app);
  npmRun(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], app);
  run(node, ['-e', "require('bcrypt').hashSync('offline-native-check',4); require('next/package.json'); console.log('Offline native modules load successfully')"], { cwd: app, env });
  const runtime = path.join(work, 'application-runtime');
  fs.mkdirSync(runtime);
  for (const name of ['node_modules', '.next']) fs.renameSync(path.join(app, name), path.join(runtime, name));
  const buildCache = path.join(runtime, '.next/cache');
  if (!buildCache.startsWith(runtime + path.sep)) throw Error('Unsafe build cache path');
  fs.rmSync(buildCache, { recursive: true, force: true });
  const applicationZip = path.join(output, 'application.zip');
  zip(runtime, applicationZip);
  const version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'))).version;
  await record('application', version, applicationZip, 'package-lock.json');
  const receipt = JSON.parse(fs.readFileSync(path.join(source, 'release-source.json'), 'utf8').replace(/^\uFEFF/, ''));
  const manifest = {
    schemaVersion: 1, architecture: lock.architecture, minimumWindowsBuild: lock.minimumWindowsBuild,
    managerVersion: version, sourceCommit: receipt.sourceCommit,
    packageLockSha256: await hash(path.join(source, 'package-lock.json')),
    dependencyLockSha256: await hash(path.join(source, 'installer/offline/dependencies.lock.json')),
    createdAt: new Date().toISOString(), artifacts,
  };
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.copyFileSync(path.join(source, 'installer/offline/dependencies.lock.json'), path.join(output, 'dependencies.lock.json'));
  fs.writeFileSync(path.join(output, 'THIRD-PARTY.txt'), lock.artifacts.map(item => `${item.id} ${item.version}\nLicense: ${item.license}\nPublisher: ${item.url}\nUpstream archive SHA-256: ${item.sha256}\n`).join('\n') + '\nOriginal licence files are retained inside component archives. PM2 is AGPL-3.0; its licences and dependencies are included in pm2.zip. Manager dependency licences are in application.zip/node_modules.\n');
  console.log('Offline bundle ready:', output);
  console.log('Build workspace retained for verification:', work);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
