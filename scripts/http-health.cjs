const redirects = new Set([301, 302, 303, 307, 308]);
const { readDiagnostics } = require('./health-diagnostics.cjs');

function validateHealthProfile(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Health settings must be an object');
  const path = value.path ?? '/';
  if (typeof path !== 'string' || path.length > 512 || !path.startsWith('/') || path.startsWith('//') || /[\\\s\x00-\x1f?#]/.test(path)) throw new Error('Health path must be a local path, for example /api/health');
  const statuses = value.statuses ?? [];
  if (!Array.isArray(statuses) || statuses.length > 10 || statuses.some(x => !Number.isInteger(x) || x < 200 || x > 499 || redirects.has(x))) throw new Error('Expected statuses must be non-redirect HTTP codes between 200 and 499');
  const timeoutMs = value.timeoutMs ?? 60000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 180000) throw new Error('Startup timeout must be between 5 and 180 seconds');
  return { path, statuses: [...new Set(statuses)], timeoutMs };
}

// Follow only redirects on this exact origin. Never send a probe to an external
// host, another application port, or a URL containing credentials.
async function probeHttp(url, options = {}, request = fetch) {
  const origin = new URL(url);
  let current = origin;
  const visited = new Set();
  for (let hops = 0; hops <= 5; hops++) {
    if (visited.has(current.href)) return { ok: false, status: null, reason: 'Redirect loop' };
    visited.add(current.href);
    const response = await request(current.href, { redirect: 'manual', signal: options.signal });
    if (redirects.has(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) return { ok: false, status: response.status, reason: 'Redirect has no destination' };
      let next;
      try { next = new URL(location, current); } catch { return { ok: false, status: response.status, reason: 'Invalid redirect destination' }; }
      if (next.origin !== origin.origin || next.username || next.password) return { ok: false, status: response.status, reason: 'External redirect; configure a local readiness path' };
      current = next;
      continue;
    }
    const ok = options.statuses?.length ? options.statuses.includes(response.status) : response.status >= 200 && response.status < 300;
    const diagnostics = !ok && options.diagnostics ? await readDiagnostics(response) : undefined;
    await response.body?.cancel().catch(() => {});
    return { ok, status: response.status, reason: ok ? undefined : 'HTTP ' + response.status + ' at ' + current.pathname, ...(diagnostics ? { diagnostics } : {}) };
  }
  return { ok: false, status: null, reason: 'Too many redirects' };
}
module.exports = { probeHttp, validateHealthProfile };
