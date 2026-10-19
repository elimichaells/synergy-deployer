function startupDecision(saved, running, daemonAlive) {
  if (!Array.isArray(saved) || !saved.length || saved.some(p => !p.name || !p.pm_exec_path)) throw new Error('Saved PM2 process list is empty or invalid; refusing fallback startup');
  const names = saved.map(p => p.name);
  if (new Set(names).size !== names.length) throw new Error('Duplicate names in saved PM2 process list');
  if (running !== null) {
    const missing = saved.filter(p => p.status !== 'stopped' && !running.some(r => r.name === p.name && r.pm2_env?.status === 'online')).map(p => p.name);
    if (missing.length) throw new Error('PM2 is already running with an incomplete process list; use scoped recovery for: ' + missing.join(', '));
    return 'already-running';
  }
  if (daemonAlive) throw new Error('PM2 daemon PID is still alive but its registry did not respond; refusing to start a second daemon');
  return 'resurrect';
}
module.exports = { startupDecision };
