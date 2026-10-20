// Runs independently of PM2 and PostgreSQL. Reads only; never restarts or updates services.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createRequire } = require('node:module');
const { advanceState } = require('./server-monitor-policy.cjs');
const { probeHttp, validateHealthProfile } = require('./http-health.cjs');
const { atomicJson, updateHistory, acquireMonitorLock } = require('./monitor-state.cjs');
const exec = promisify(execFile);

function readPm2(config) {
  // Connect directly to the existing RPC socket. PM2's normal connect/CLI can spawn a daemon.
  return new Promise((resolve, reject) => {
    const localRequire = createRequire(path.join(config.pm2PackageRoot, 'package.json'));
    const axon = localRequire('pm2-axon');
    const rpc = localRequire('pm2-axon-rpc');
    const socket = axon.socket('req');
    const client = new rpc.Client(socket);
    let done = false;
    const finish = (err, rows) => { if (done) return; done = true; clearTimeout(timer); socket.close(); err ? reject(err) : resolve(rows); };
    const timer = setTimeout(() => finish(new Error('PM2 read timeout')), 4000);
    socket.on('error', err => finish(err));
    socket.once('connect', () => client.call('getMonitorData', {}, (err, rows) => finish(err, rows)));
    socket.connect(config.pm2Socket || '\\\\.\\pipe\\rpc.sock');
  });
}

async function checkHttp(name, url, profile = {}) {
  const started = Date.now();
  try {
    const response = await probeHttp(url, { statuses: profile.statuses, diagnostics: true, signal: AbortSignal.timeout(4000) });
    return { name, ...response, endpoint: new URL(url).pathname, expected: profile.statuses?.length ? profile.statuses.join(', ') : '200–299', ms: Date.now() - started };
  } catch (error) { return { name, ok: false, status: null, endpoint: new URL(url).pathname, expected: profile.statuses?.length ? profile.statuses.join(', ') : '200–299', reason: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'Request exceeded the 4-second check timeout' : 'Connection could not be established', ms: Date.now() - started }; }
}

async function collect(config) {
  const sample = { at: Date.now(), disks: [], logs: [], memory: { total: os.totalmem(), free: os.freemem() }, pm2Updates: 0, apps: [], checks: [], pm2Error: false, collectorError: null };
  const errors = [];
  const safe = async (label, work) => { try { await work(); } catch { errors.push(label); } };
  let rows = [];
  await Promise.all([
    safe('disk checks', async () => { for (const root of config.volumes) { const s = await fs.statfs(root); sample.disks.push({ name: root, free: s.bavail * s.bsize, total: s.blocks * s.bsize }); } }),
    safe('process checks', async () => {
      const command = "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match '[\\\\/]pm2\\s+update(?:\\s|$)' }).Count";
      const result = await exec('powershell.exe', ['-NoProfile','-NonInteractive','-Command',command], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
      const count = Number(result.stdout.trim()); if (!Number.isFinite(count)) throw new Error('Invalid count'); sample.pm2Updates = count;
    }),
    (async () => { try { rows = await readPm2(config); } catch { sample.pm2Error = true; } })(),
  ]);
  await safe('saved process list', async () => {
    const saved = JSON.parse(await fs.readFile(path.join(config.pm2Home, 'dump.pm2'), 'utf8'));
    const expected = saved.filter(p => p.status !== 'stopped');
    const names = new Set([...expected.map(p => p.name), ...rows.filter(p => p.pm2_env?.pmx !== false).map(p => p.name)].filter(name => !/:candidate:|-candidate-/.test(name)));
    sample.apps = [...names].map(name => { const row = rows.find(p => p.name === name); return { name, status: row?.pm2_env?.status || null, restarts: row?.pm2_env?.restart_time || 0, uptime: row?.pm2_env?.pm_uptime || 0 }; });
  });
  await safe('log checks', async () => {
    for (const folder of config.logDirectories) {
      const entries = await fs.readdir(folder, { withFileTypes: true });
      for (const entry of entries.filter(e => e.isFile() && e.name.endsWith('.log') && !/__\d{4}-/.test(e.name))) {
        const s = await fs.stat(path.join(folder, entry.name));
        if(s.size >= 50 * 1024 ** 2) sample.logs.push({ name: path.basename(folder) + '/' + entry.name, bytes: s.size });
      }
    }
    const s = await fs.stat(path.join(config.pm2Home, 'pm2.log'));
    if(s.size >= 50 * 1024 ** 2) sample.logs.push({name:'PM2 daemon log',bytes:s.size});
  });
  const queue = [...config.checks];
  // Probe configured app ports only when PM2 says they are online. Intentional stops stay quiet.
  for (const row of rows) {
    const p = row.pm2_env;
    if(p?.status === 'online' && !/:candidate:|-candidate-/.test(row.name) && /^\d+$/.test(String(p.PORT)) && Number(p.PORT) > 0 && Number(p.PORT) < 65536) {
      try {
        const profile = validateHealthProfile(config.applications?.[row.name] || (row.name === 'exceedbackend' ? {path:'/health'} : {}));
        queue.push({ name: row.name, url: `http://127.0.0.1:${p.PORT}${profile.path}`, statuses: profile.statuses });
      } catch {
        sample.checks.push({ name: row.name, ok: false, status: null, ms: 0, reason: 'Invalid readiness settings' });
      }
    }
  }
  await Promise.all(Array.from({length:4}, async () => { while(queue.length){const item=queue.shift(); sample.checks.push(await checkHttp(item.name,item.url,item));} }));
  for (const app of sample.apps) {
    const check = sample.checks.find(c => c.name === app.name);
    app.health = sample.pm2Error ? 'unknown' : app.status === 'stopped' || app.status === 'stopping' ? 'stopped' : app.status !== 'online' ? 'offline' : !check ? 'unknown' : check.ok ? 'ready' : 'degraded';
  }
  sample.collectorError = errors.length ? errors.join(', ') : null;
  return sample;
}

async function run(configPath) {
  const config = JSON.parse((await fs.readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''));
  const unlock = await acquireMonitorLock(config.stateFile);
  if (!unlock) { console.log('Another monitor sample is running; skipped safely'); return; }
  try {
  let previous;
  try { previous = JSON.parse(await fs.readFile(config.stateFile, 'utf8')); } catch { /* First sample. */ }
  const sample = await collect(config);
  try { await updateHistory(config, previous, sample); }
  catch { sample.collectorError = [sample.collectorError, 'health history persistence'].filter(Boolean).join(', '); }
  try { await require('./monitor-state.cjs').updateUptime(config, sample); }
  catch { sample.collectorError = [sample.collectorError, 'uptime history persistence'].filter(Boolean).join(', '); }
  const state = advanceState(previous, sample);
  await fs.mkdir(path.dirname(config.stateFile), { recursive: true });
  await atomicJson(config.stateFile, state);
  console.log(JSON.stringify({checkedAt:state.checkedAt,openAlerts:state.incidents.filter(x=>!x.resolvedAt).length,pm2Responding:!sample.pm2Error,collectorError:sample.collectorError}));
  } finally { await unlock(); }
}
if(require.main===module){
  const configPath=process.argv[2];
  if(!configPath){console.error('Supply a monitor configuration file');process.exit(1);}
  const deadline=setTimeout(()=>{console.error('Monitor exceeded its deadline');process.exit(2)},50000);
  run(configPath).catch(error=>{console.error(error.message);process.exitCode=1}).finally(()=>clearTimeout(deadline));
}
module.exports={collect,readPm2,checkHttp};
