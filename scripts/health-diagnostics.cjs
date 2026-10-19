// Health bodies are untrusted. Classify a small JSON response into fixed messages;
// never persist arbitrary response text, credentials, stack traces or URLs.
function classifyReadiness(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const issues = Array.isArray(body.issues) ? body.issues.filter(x => typeof x === 'string').slice(0, 8).join(' ').slice(0, 4096) : '';
  if (body.check === 'configuration') {
    if (/DATABASE_URL/i.test(issues)) return { dependency: 'Database configuration', issueCode: 'database-configuration', detail: 'The application reports an invalid or missing database connection setting or application role.', nextStep: 'Review this app’s database connection and required login role. Use the intended application account; do not grant wider permissions to bypass the check.' };
    return { dependency: 'Application configuration', issueCode: 'configuration', detail: 'The application reports that required runtime settings are missing or invalid.', nextStep: 'Review the application settings and deployment diagnostics before restarting it.' };
  }
  if (body.database === 'down' || body.check === 'database') {
    if (/credentials|authentication/i.test(issues)) return { dependency: 'Database', issueCode: 'database-authentication', detail: 'The application reports that database authentication was rejected.', nextStep: 'Verify the configured application account and credentials against the intended database.' };
    if (/permissions|privileges|grants/i.test(issues)) return { dependency: 'Database', issueCode: 'database-permissions', detail: 'The application reports missing database permissions or schema setup.', nextStep: 'Review the app’s documented database setup and least-privilege grants using its administrative workflow.' };
    if (/schema|initialization|migrations/i.test(issues)) return { dependency: 'Database', issueCode: 'database-schema', detail: 'The application reports incomplete database initialization.', nextStep: 'Review the app’s database setup and migration status before applying any database change.' };
    return { dependency: 'Database', issueCode: 'database-unavailable', detail: 'The application’s database readiness check failed.', nextStep: 'Check whether a database is configured, then verify its address, availability and application credentials.' };
  }
  if (body.ready === false || body.status === 'degraded') return { dependency: 'Application readiness', issueCode: 'not-ready', detail: 'The application reports that it is not ready to serve normal requests.', nextStep: 'Inspect the application’s startup diagnostics and dependency health.' };
  return undefined;
}

async function readDiagnostics(response) {
  if (!/\bapplication\/(?:[a-z0-9.-]+\+)?json\b/i.test(response.headers.get('content-type') || '')) return undefined;
  if (Number(response.headers.get('content-length')) > 8192) return undefined;
  const reader = response.body?.getReader(); if (!reader) return undefined;
  const chunks = []; let size = 0;
  try {
    for (let i = 0; i < 32; i++) {
      const { done, value } = await reader.read();
      if (done) return classifyReadiness(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      size += value.byteLength; if (size > 8192) return undefined;
      chunks.push(Buffer.from(value));
    }
  } catch { return undefined; }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return undefined;
}
module.exports = { classifyReadiness, readDiagnostics };
