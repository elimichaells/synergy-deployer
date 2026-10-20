const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
// This helper only connects to the existing daemon. It cannot launch a daemon,
// execute shell text, change environment values, or address a process by wildcard.
function callExisting(config, action, id, requirePackage) {
  if (!['inventory', 'restart'].includes(action) || action === 'restart' && (!Number.isInteger(id) || id < 0)) throw Error('Invalid recovery action');
  const localRequire = requirePackage || createRequire(path.join(config.pm2PackageRoot, 'package.json'));
  return new Promise((resolve, reject) => {
    const socket = localRequire('pm2-axon').socket('req');
    const client = new (localRequire('pm2-axon-rpc').Client)(socket);
    let done = false;
    const finish = (error, rows) => {
      if (done) return;
      done = true; clearTimeout(timer); socket.close();
      if (error) return reject(Error('PM2 operation did not complete'));
      if (action === 'restart') return resolve({ ok: true });
      if (!Array.isArray(rows)) return reject(Error('Invalid process inventory'));
      resolve(rows.map(p => ({ id: p.pm_id, name: p.name, pid: p.pid, status: p.pm2_env?.status,
        restarts: p.pm2_env?.restart_time, cwd: p.pm2_env?.pm_cwd, port: Number(p.pm2_env?.PORT) })));
    };
    const timer = setTimeout(() => finish(Error('RPC timeout')), action === 'restart' ? 25000 : 4000);
    socket.on('error', finish);
    socket.once('connect', () => client.call(action === 'restart' ? 'restartProcessId' : 'getMonitorData',
      action === 'restart' ? { id, env: {} } : {}, finish));
    socket.connect(config.pm2Socket || '\\\\.\\pipe\\rpc.sock');
  });
}
if (require.main === module) {
  (async () => {
    if (process.env.MANAGER_PREVIEW === '1') throw Error('Preview is read-only');
    const file = process.env.MANAGER_MONITOR_CONFIG || path.join(process.env.PROGRAMDATA || process.env.ProgramData || 'C:\\ProgramData', 'Manager', 'monitor', 'config.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const action = process.argv[2], id = /^\d+$/.test(process.argv[3] || '') ? Number(process.argv[3]) : undefined;
    console.log(JSON.stringify(await callExisting(config, action, id)));
  })().catch(() => { console.error('The existing PM2 daemon could not complete this operation.'); process.exitCode = 1; });
}
module.exports = { callExisting };
