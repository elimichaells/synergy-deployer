const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

async function check(mode, root = path.join(process.env.ProgramData, 'Manager')) {
  const boot = JSON.parse(fs.readFileSync(path.join(root, 'pm2-startup.json'), 'utf8').replace(/^\uFEFF/, ''));
  const report = JSON.parse(fs.readFileSync(path.join(root, 'install-report.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (mode === 'pm2') {
    // Read the existing daemon directly: the PM2 CLI can create a new daemon.
    const { readPm2 } = require(path.join(report.managerRoot, 'scripts/server-monitor.cjs'));
    const rows = await readPm2({ pm2PackageRoot: path.join(path.dirname(boot.pm2), 'node_modules/pm2') });
    const selected = rows.filter(row => row.name === 'manager-caddy');
    if (selected.length !== 1) throw Error('Expected exactly one existing manager-caddy PM2 entry');
    const row = selected[0], env = row.pm2_env;
    if (path.resolve(env.pm_exec_path).toLowerCase() !== path.resolve(report.webRoot, 'caddy.exe').toLowerCase()) throw Error('The PM2 entry belongs to a different Caddy installation');
    if (env.PM2_HOME && path.resolve(env.PM2_HOME).toLowerCase() !== path.resolve(root, 'pm2').toLowerCase()) throw Error('The PM2 entry belongs to another daemon home');
    return { name: row.name, pid: row.pid, status: env.status, executable: env.pm_exec_path };
  }
  if (mode !== 'https') throw Error('Expected pm2 or https');
  const url = new URL('/login', report.managerUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw Error('Invalid Manager HTTPS URL');
  const options = { rejectUnauthorized: true, timeout: 5000 };
  if (report.tlsMode === 'internal') options.ca = fs.readFileSync(path.join(boot.caddyDataHome, 'caddy/pki/authorities/local/root.crt'));
  return new Promise((resolve, reject) => {
    const request = https.get(url, options, response => {
      response.resume();
      if (response.statusCode !== 200) reject(Error('Manager HTTPS login returned HTTP ' + response.statusCode));
      else resolve({ https: url.origin, status: response.statusCode, certificateVerified: true });
    });
    request.on('timeout', () => request.destroy(Error('Manager HTTPS check timed out')));
    request.on('error', reject);
  });
}
if (require.main === module) check(process.argv[2], process.argv[3]).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { check };
