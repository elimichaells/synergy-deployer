export type BackupCredentialSource = 'application' | 'connection'

export function backupCredentialSource(value: unknown): BackupCredentialSource {
  if (value !== 'application' && value !== 'connection') throw new Error('Select application or managed connection credentials for backups')
  return value
}

export function selectBackupCredential(target: {
  username: string | null; password_ciphertext: string | null
  connection_username: string | null; connection_password_ciphertext: string | null; managed: boolean
}, source: BackupCredentialSource) {
  const connection = source === 'connection'
  if (connection && !target.managed) throw new Error('Connection credentials require a managed database connection')
  const username = connection ? target.connection_username : target.username
  const ciphertext = connection ? target.connection_password_ciphertext : target.password_ciphertext
  if (!username || !ciphertext) throw new Error('The selected backup credential is unavailable; update the saved connection')
  return { username, ciphertext }
}

export function backupFailure(output: string, secrets: string[] = []) {
  let safe = output
  for (const secret of secrets.filter(Boolean)) safe = safe.split(secret).join('[REDACTED]')
  safe = safe.replace(/(postgres(?:ql)?:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/(password|token|secret)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]')
  // pg_dump can end with a huge LOCK TABLE list. Preserve the actual error first.
  const reason = safe.split(/\r?\n/).filter(line => /error:|fatal:|timed out|ENOENT/i.test(line)).join(' ')
  return 'pg_dump failed: ' + (reason || safe || 'unknown error').slice(0, 1000)
}
