/** Runtime logs are untrusted and may contain application credentials. */
export function formatRuntimeDiagnostics(output: string, environment: Record<string, string>) {
  let safe = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  const secrets = Object.entries(environment).filter(([key, value]) => value &&
    /password|secret|token|key|credential|(?:database|redis|mongo).*url|mongodb_uri/i.test(key))
    .map(([, value]) => value).sort((a, b) => b.length - a.length)
  for (const secret of secrets) safe = safe.split(secret).join('[redacted]')
  safe = safe.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/((?:password|secret|token|api[_-]?key|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  const lines = safe.split(/\r?\n/).filter(line => line.trim()).slice(-30)
  const errors = lines.filter(line => /\b(?:error|exception|fatal|panic|ECONN|authentication failed|permission denied|does not exist|cannot find)\b/i.test(line) && !/^\s*at\s/.test(line))
  const summary = errors.at(-1)?.trim().slice(0, 500)
  return { summary, details: lines.slice(-15).map(line => `[runtime] ${line.slice(0, 1000)}`).join('\n') + (lines.length ? '\n' : '') }
}
