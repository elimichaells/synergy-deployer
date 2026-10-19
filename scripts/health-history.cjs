const MINUTE = 60_000, BUCKET = 5 * MINUTE, RETENTION = 7 * 24 * 60 * MINUTE;
const empty = () => ({ passed: 0, failed: 0, unknown: 0, paused: 0, latencyCount: 0, totalMs: 0, maxMs: 0 });
const validTime = value => Number.isFinite(value) && value > 0;

// One observation per minute, five-minute rollups, seven days retained. No
// response bodies, incident text, environment values or database access.
function recordHistory(previous, sample) {
  if (!validTime(sample.at)) throw new Error('Invalid history timestamp');
  const prior = previous?.version === 1 && Array.isArray(previous.buckets) ? previous : { version: 1, startedAt: sample.at, lastSampleAt: 0, buckets: [] };
  if (Math.floor(sample.at / MINUTE) <= Math.floor(prior.lastSampleAt / MINUTE)) return prior;
  const at = Math.floor(sample.at / BUCKET) * BUCKET;
  const buckets = prior.buckets.filter(b => validTime(b.at) && b.at >= at - RETENTION && b.at <= at).map(b => ({ ...b }));
  let bucket = buckets.find(b => b.at === at);
  if (!bucket) { bucket = { at, samples: 0, services: {} }; buckets.push(bucket); }
  bucket.services = Object.assign(Object.create(null), bucket.services); bucket.samples++;
  const checks = new Map((sample.checks || []).map(c => [c.name, c]));
  const apps = new Map((sample.apps || []).map(a => [a.name, a]));
  const previouslyChecked = new Set(prior.buckets.flatMap(b => Object.keys(b.services || {})));
  const names = new Set([...checks.keys(), ...[...apps.keys()].filter(name => previouslyChecked.has(name)), ...(sample.pm2Error ? previouslyChecked : [])]);
  for (const name of names) {
    if (typeof name !== 'string' || name.length > 200 || /[\x00-\x1f]/.test(name)) continue;
    const check = checks.get(name), app = apps.get(name), value = { ...empty(), ...bucket.services[name] };
    if (check) {
      value[check.ok ? 'passed' : 'failed']++;
      if (check.status && Number.isFinite(check.ms) && check.ms >= 0) { const ms = Math.min(60_000, check.ms); value.totalMs += ms; value.latencyCount++; value.maxMs = Math.max(value.maxMs, ms); }
    } else if (sample.pm2Error) value.unknown++;
    else if (['stopped', 'stopping'].includes(app?.status)) value.paused++;
    else if (!app?.status || app.status === 'errored') value.failed++;
    else value.unknown++;
    bucket.services[name] = value;
  }
  return { version: 1, startedAt: prior.startedAt, lastSampleAt: sample.at, buckets: buckets.slice(-2017) };
}

function summarizeHistory(history, range, service, now = Date.now()) {
  const duration = { '1h': 60 * MINUTE, '24h': 24 * 60 * MINUTE, '7d': RETENTION }[range];
  if (!duration) throw new Error('History range must be 1h, 24h or 7d');
  const intervalMs = range === '7d' ? 60 * MINUTE : BUCKET;
  const to = now, from = Math.floor((now - duration) / intervalMs) * intervalMs;
  const source = history?.version === 1 && Array.isArray(history.buckets) ? history.buckets.filter(b => b.at >= from && b.at <= to) : [];
  const totals = new Map(), timeline = new Map();
  const add = (target, value) => { for (const k of ['passed', 'failed', 'unknown', 'paused', 'latencyCount', 'totalMs']) target[k] += Number.isFinite(value[k]) ? Math.max(0, value[k]) : 0; target.maxMs = Math.max(target.maxMs, value.maxMs || 0); };
  for (const bucket of source) {
    const time = Math.floor(bucket.at / intervalMs) * intervalMs;
    for (const [name, value] of Object.entries(bucket.services || {})) {
      const total = totals.get(name) || empty(); add(total, value); totals.set(name, total);
      if (service && name !== service) continue;
      const point = timeline.get(time) || empty(); add(point, value); timeline.set(time, point);
    }
  }
  const stats = value => ({ ...value, successPercent: value.passed + value.failed ? 100 * value.passed / (value.passed + value.failed) : null, averageMs: value.latencyCount ? value.totalMs / value.latencyCount : null });
  const points = [];
  for (let at = from; at <= to; at += intervalMs) {
    const value = timeline.get(at);
    const expected = Math.max(0, Math.floor((Math.min(at + intervalMs, to) - at) / MINUTE)) * (service ? 1 : totals.size);
    const observed = value ? value.passed + value.failed + value.unknown + value.paused : 0;
    const missing = Math.max(0, expected - observed);
    points.push({ at, missing, ...(value ? stats(value) : stats(empty())), state: !value ? 'gap' : value.failed ? 'failed' : value.unknown ? 'unknown' : missing ? 'partial' : value.passed ? 'healthy' : 'paused' });
  }
  const services = [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ name, ...stats(value) }));
  const combined = empty(); for (const [name, value] of totals) if (!service || name === service) add(combined, value);
  return { range, service: service || null, from, to, intervalMs, startedAt: history?.startedAt || null, checkedAt: history?.lastSampleAt || null, summary: stats(combined), services, points };
}
module.exports = { recordHistory, summarizeHistory };
