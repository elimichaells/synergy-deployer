import { createHmac, timingSafeEqual } from 'crypto'

export function pgwebConnectToken() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured')
  return createHmac('sha256', process.env.JWT_SECRET).update('manager:pgweb-connect').digest('base64url')
}

export function validPgwebConnectToken(value: unknown) {
  if (typeof value !== 'string') return false
  const expected = Buffer.from(pgwebConnectToken())
  const supplied = Buffer.from(value)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}
