const GB = 1024 ** 3;
const MB = 1024 ** 2;
const gb = value => (value / GB).toFixed(1);

function conditionsFor(sample, history = []) {
  const conditions = [];
  const add = (key, severity, message, action, details = {}) => conditions.push({ key, severity, message, action, ...details });
  for (const disk of sample.disks) {
    const percent = 100 * disk.free / disk.total;
    if (percent <= 10 || disk.free <= 15 * GB) add('disk:' + disk.name, 'critical', `${disk.name} has only ${gb(disk.free)} GB (${percent.toFixed(1)}%) free.`, 'Free space or expand the volume before running deployments or backups.');
    else if (percent <= 20 || disk.free <= 30 * GB) add('disk:' + disk.name, 'warning', `${disk.name} has ${gb(disk.free)} GB (${percent.toFixed(1)}%) free.`, 'Review growing databases, backups, release folders and logs.');
    const earlier = history.find(s => sample.at - s.at >= 5 * 60_000 && sample.at - s.at <= 30 * 60_000 && s.disks?.some(d => d.name === disk.name));
    if (earlier) {
      const previous = earlier.disks.find(d => d.name === disk.name);
      const growth = previous.free - disk.free;
      const hours = growth > 0 ? disk.free / growth * (sample.at - earlier.at) / 3600_000 : Infinity;
      if (growth >= GB && hours < 6) add('disk-growth:' + disk.name, hours < 2 ? 'critical' : 'warning', `${disk.name} could fill in about ${hours.toFixed(1)} hours at its recent growth rate.`, 'Find the growing files now. This estimate assumes the recent growth continues.');
    }
  }
  for (const log of sample.logs) if (log.bytes >= 100 * MB) add('log:' + log.name, log.bytes >= 500 * MB ? 'critical' : 'warning', `${log.name} has grown to ${(log.bytes / MB).toFixed(0)} MB.`, 'Check log rotation and the repeating errors before removing any logs.');
  if (sample.memory.free <= Math.max(sample.memory.total * .1, 1536 * MB)) add('memory', sample.memory.free < sample.memory.total * .05 ? 'critical' : 'warning', `Only ${gb(sample.memory.free)} GB of server memory is free.`, 'Review Memory in Infrastructure and pause heavy builds or backups.');
  if (sample.pm2Updates >= 2) add('pm2-updates', sample.pm2Updates >= 5 ? 'critical' : 'warning', `${sample.pm2Updates} PM2 update processes are running at once.`, 'Investigate the update loop. Do not run another update or restart all applications.');
  if (sample.pm2Error) add('pm2-unavailable', 'critical', 'The PM2 process registry is not responding.', 'Check the daemon and preserve its saved process list before recovery.');
  if (sample.collectorError) add('collector', 'critical', 'Part of the server check could not run: ' + sample.collectorError, 'Check the monitor task and permissions; some server conditions are unknown.');
  for (const app of sample.pm2Error ? [] : sample.apps) {
    if (app.status === 'stopped' || app.status === 'stopping') continue;
    if (!app.status || app.status === 'errored') add('app:' + app.name, 'critical', `${app.name} is ${app.status || 'missing from PM2'}.`, 'Inspect its process and logs. Verify the port before starting a replacement.');
    const earlier = history.find(s => sample.at - s.at <= 10 * 60_000 && sample.at - s.at >= 60_000 && s.apps?.some(a => a.name === app.name && a.uptime === app.uptime));
    const prior = earlier?.apps.find(a => a.name === app.name);
    // Uptime changes on restart, so use a same-name counter baseline unless it reset.
    const baseline = prior || history.find(s => sample.at - s.at <= 10 * 60_000)?.apps?.find(a => a.name === app.name);
    const restarts = baseline ? app.restarts - baseline.restarts : 0;
    if (restarts >= 5) add('restarts:' + app.name, restarts >= 10 ? 'critical' : 'warning', `${app.name} restarted ${restarts} times within ten minutes.`, 'Inspect its crash log and dependencies before attempting another restart.');
  }
  for (const check of sample.checks) {
    const details = { service: check.name, endpoint: check.endpoint, expected: check.expected, observed: check.status ? 'HTTP ' + check.status : 'No HTTP response', responseMs: check.ms,
      dependency: check.diagnostics?.dependency || 'HTTP readiness', issueCode: check.diagnostics?.issueCode || 'http-check', detail: check.diagnostics?.detail || check.reason || 'The readiness endpoint did not return an expected response.' };
    if (!check.ok) add('http:' + check.name, 'critical', `${check.name}: ${check.diagnostics?.detail || (check.status ? 'readiness returned HTTP ' + check.status + '.' : 'readiness endpoint is unreachable.')}`, check.diagnostics?.nextStep || 'Inspect the app’s readiness endpoint, process logs and required services before restarting it.', details);
    else if (check.ms >= 2000) add('slow:' + check.name, 'warning', `${check.name} took ${(check.ms / 1000).toFixed(1)} seconds to respond locally.`, 'Investigate slow requests before they reach proxy timeouts.', { ...details, detail: 'Local readiness response exceeded the 2-second warning threshold.', issueCode: 'slow-response' });
  }
  return conditions;
}

function advanceState(previous, sample) {
  const prior = previous || { history: [], incidents: [], pending: {} };
  const history = (prior.history || []).filter(s => sample.at - s.at <= 60 * 60_000);
  const conditions = conditionsFor(sample, history);
  const present = new Set(conditions.map(c => c.key));
  const incidents = (prior.incidents || []).map(x => ({ ...x }));
  const pending = {};
  const contiguous = prior.checkedAt && sample.at - Date.parse(prior.checkedAt) <= 150_000;
  for (const condition of conditions) {
    pending[condition.key] = contiguous ? (prior.pending?.[condition.key] || 0) + 1 : 1;
    const immediately = condition.key.startsWith('disk:') && condition.severity === 'critical' || condition.key === 'pm2-updates' && sample.pm2Updates >= 5;
    const needed = condition.key === 'memory' ? 3 : 2;
    let open = incidents.find(x => x.key === condition.key && !x.resolvedAt);
    if (!open && !immediately && pending[condition.key] < needed) continue;
    if (!open) { open = { id: condition.key + ':' + sample.at, openedAt: new Date(sample.at).toISOString() }; incidents.unshift(open); }
    Object.assign(open, condition, { lastSeenAt: new Date(sample.at).toISOString(), healthySamples: 0 });
  }
  for (const incident of incidents) if (!incident.resolvedAt && !present.has(incident.key)) {
    // Never resolve checks whose underlying collection failed.
    if (sample.collectorError || sample.pm2Error && /^(app:|restarts:|http:)/.test(incident.key)) continue;
    incident.healthySamples = contiguous ? (incident.healthySamples || 0) + 1 : 1;
    if (incident.healthySamples >= 2) incident.resolvedAt = new Date(sample.at).toISOString();
  }
  const open = incidents.filter(x => !x.resolvedAt);
  return { version: 1, checkedAt: new Date(sample.at).toISOString(), snapshot: sample, pending,
    incidents: [...open, ...incidents.filter(x => x.resolvedAt).slice(0, 100)], history: [...history, sample].slice(-61) };
}
module.exports = { conditionsFor, advanceState };
