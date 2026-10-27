/** A portable .env subset. Quoted values round-trip exactly, including newlines and #. */
export function environmentText(values: Record<string, string>): string {
  return Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n')
}
export function parseEnvironmentText(text: string): Record<string, string> {
  const result = Object.create(null) as Record<string, string>
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) throw new Error(`Line ${index + 1}: use NAME=value.`)
    let value = match[2]
    if (Object.hasOwn(result, match[1])) throw new Error(`Line ${index + 1}: duplicate variable ${match[1]}.`)
    if (value.startsWith('"')) {
      try { value = JSON.parse(value) } catch { throw new Error(`Line ${index + 1}: use a quoted string with escaped newlines (\\n).`) }
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'") || value.length < 2) throw new Error(`Line ${index + 1}: close the quoted value.`)
      value = value.slice(1, -1)
    } else value = value.replace(/\s+#.*$/, '').trim()
    result[match[1]] = value
  }
  return result
}
