const MINUTE = 60_000, DAY = 1440 * MINUTE;
const validName = name => typeof name === 'string' && name.length > 0 && name.length <= 200 && !/[\x00-\x1f]/.test(name);
function validateUptime(value) {
  if (!value || value.version !== 1 || !Number.isFinite(value.lastSampleAt) || !Array.isArray(value.days) || value.days.length > 31) throw Error('Invalid uptime history');
  for (const day of value.days) {
    if (!Number.isFinite(day.at) || day.at % DAY || !day.services || typeof day.services !== 'object' || Array.isArray(day.services)) throw Error('Invalid uptime day');
    for (const [name, states] of Object.entries(day.services)) if (!validName(name) || typeof states !== 'string' || states.length !== 1440 || /[^ud?p-]/.test(states)) throw Error('Invalid uptime observations');
  }
  return value;
}
function recordUptime(previous, sample) {
  if (!Number.isFinite(sample.at) || sample.at <= 0) throw Error('Invalid sample time');
  const prior = previous ? validateUptime(previous) : { version: 1, startedAt: sample.at, lastSampleAt: 0, days: [] };
  if (Math.floor(sample.at / MINUTE) <= Math.floor(prior.lastSampleAt / MINUTE)) return prior;
  const at = Math.floor(sample.at / DAY) * DAY, minute = Math.floor((sample.at - at) / MINUTE);
  const days = prior.days.filter(d => d.at >= at - 30 * DAY && d.at <= at).map(d => ({ ...d, services: { ...d.services } }));
  let day = days.find(d => d.at === at);
  if (!day) { day = { at, services: Object.create(null) }; days.push(day); }
  // Static services from configured checks and previously tracked apps are retained.
  const checks = new Map((sample.checks || []).map(c => [c.name, c]));
  const apps = new Map((sample.apps || []).map(a => [a.name, a]));
  const names = new Set([...prior.days.flatMap(d => Object.keys(d.services)), ...checks.keys(), ...apps.keys()]);
  for (const name of names) {
    if (!validName(name)) continue;
    const check = checks.get(name), app = apps.get(name);
    const state = check ? (check.ok ? 'u' : 'd') : sample.pm2Error || sample.collectorError ? '?' : ['stopped', 'stopping'].includes(app?.status) ? 'p' : app?.status === 'errored' ? 'd' : '?';
    const old = Object.hasOwn(day.services, name) ? day.services[name] : '-'.repeat(1440);
    Object.defineProperty(day.services, name, { value: old.slice(0, minute) + state + old.slice(minute + 1), enumerable: true, configurable: true, writable: true });
  }
  return { version: 1, startedAt: prior.startedAt, lastSampleAt: sample.at, days: days.slice(-31) };
}
function summarizeUptime(history, range = '24h', now = Date.now()) {
  const duration = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY }[range];
  if (!duration) throw Error('Uptime range must be 24h, 7d or 30d');
  if (history) validateUptime(history);
  const to = Math.floor(now / MINUTE) * MINUTE, from = to - duration + MINUTE, expected = duration / MINUTE;
  const names = new Set((history?.days || []).flatMap(d => Object.keys(d.services)));
  const services = [...names].sort().map(name => {
    const counts = { up: 0, down: 0, unknown: 0, paused: 0 };
    for (const day of history.days) {
      const states = day.services[name];
      if (!states) continue;
      for (let i = Math.max(0, Math.ceil((from - day.at) / MINUTE)); i <= Math.min(1439, Math.floor((to - day.at) / MINUTE)); i++) {
        const key = { u: 'up', d: 'down', '?': 'unknown', p: 'paused' }[states[i]];
        if (key) counts[key]++;
      }
    }
    const checked = counts.up + counts.down, missing = Math.max(0, expected - checked - counts.unknown - counts.paused);
    const percent = checked ? 100 * counts.up / checked : null;
    const coverage = 100 * checked / expected;
    return { name, ...counts, missing, expected, checked, percent, coverage, target: 99.9,
      budgetSamplesRemaining: checked * .001 - counts.down,
      assessment: coverage < 99 ? 'insufficient-coverage' : percent >= 99.9 ? 'within-target' : 'below-target' };
  });
  return { range, from, to, startedAt: history?.startedAt || null, checkedAt: history?.lastSampleAt || null, services };
}
module.exports = { validateUptime, recordUptime, summarizeUptime };
