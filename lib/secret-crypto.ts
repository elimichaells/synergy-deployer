import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'

function encryptionKey() {
  const secret = process.env.MANAGER_ENCRYPTION_KEY || process.env.GITHUB_CONNECTIONS_ENCRYPTION_KEY || process.env.JWT_SECRET
  if (!secret) throw new Error('MANAGER_ENCRYPTION_KEY or JWT_SECRET must be configured')
  return createHash('sha256').update(`manager:secrets:${secret}`).digest()
}

export function encryptSecret(value: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`
}

export function decryptSecret(value: string) {
  const [version, ivValue, tagValue, encryptedValue] = value.split(':')
  if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) throw new Error('Unsupported secret encryption format')
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivValue, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8')
}
