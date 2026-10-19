const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readPm2 } = require('./server-monitor.cjs');
const { startupDecision } = require('./pm2-startup-policy.cjs');

async function main(config, validateOnly) {
  for (const key of ['pm2Home','pm2PackageRoot','nodeExe']) if (!path.isAbsolute(config[key]) || !fs.existsSync(config[key])) throw new Error('Startup path missing: ' + key);
  const saved = JSON.parse(fs.readFileSync(path.join(config.pm2Home, 'dump.pm2'), 'utf8'));
  startupDecision(saved, null, false);
  for (const app of saved.filter(p => p.status !== 'stopped')) {
    if (!fs.existsSync(app.pm_exec_path) || !fs.existsSync(app.pm_cwd)) throw new Error('Saved application path is missing: ' + app.name);
  }
  let running = null;
  try { running = await readPm2(config); } catch { /* Validate daemon PID before considering resurrection. */ }
  let daemonAlive = false;
  try { const pid = Number(fs.readFileSync(path.join(config.pm2Home,'pm2.pid'),'utf8').trim()); if(Number.isInteger(pid) && pid > 0) { process.kill(pid,0); daemonAlive = true; } } catch (error) { if(error.code === 'EPERM') daemonAlive = true; }
  const decision = startupDecision(saved, running, daemonAlive);
  console.log(JSON.stringify({ mode: validateOnly ? 'validation' : 'startup', decision, savedProcesses: saved.length, pm2Home: config.pm2Home }));
  if (validateOnly || decision === 'already-running') return;
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(config.nodeExe, [path.join(config.pm2PackageRoot,'bin','pm2'),'resurrect'], {
      windowsHide:true, stdio:['ignore','ignore','ignore'], env:{...process.env,PM2_HOME:config.pm2Home,Path:path.dirname(config.nodeExe)+';'+(process.env.Path || process.env.PATH || '')},
    });
    child.once('error',reject); child.once('exit',resolve);
    const timeout = setTimeout(() => { child.kill(); reject(new Error('PM2 resurrection exceeded 90 seconds; inspect before retrying')); },90000);
    child.once('exit',()=>clearTimeout(timeout)); child.once('error',()=>clearTimeout(timeout));
  });
  if(exitCode !== 0) throw new Error('PM2 resurrection failed; original saved process list retained');
  const deadline = Date.now() + 30000;
  while (true) {
    try { startupDecision(saved, await readPm2(config), true); break; }
    catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 2000)); }
  }
  console.log('Saved applications restored; no update or ecosystem fallback was run.');
}
if(require.main === module) {
  const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8').replace(/^\uFEFF/,''));
  main(config,process.argv.includes('--validate')).catch(error=>{console.error(error.message);process.exitCode=1});
}
module.exports={main};
