import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { cookies } from 'next/headers'
import { query } from '@/lib/db'

export type Role = 'admin' | 'operator' | 'viewer'

export interface SessionUser {
  id: string
  email: string
  name: string
  role: Role
}

const COOKIE_NAME = 'manager_session'

function getJwtSecret() {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    throw new Error('JWT_SECRET is not configured')
  }
  return secret
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12)
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash)
}

export function signSession(user: SessionUser) {
  return jwt.sign(user, getJwtSecret(), { expiresIn: '7d' })
}

export function verifySession(token: string) {
  return jwt.verify(token, getJwtSecret()) as SessionUser
}

export async function setSessionCookie(token: string) {
  const store = await cookies()
  store.set({
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  })
}

export async function clearSessionCookie() {
  const store = await cookies()
  store.set({
    name: COOKIE_NAME,
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  })
}

// A signed token lasts 7 days, so the account's current role and status are checked
// (briefly cached) to make demotions and disabled accounts take effect straight away.
const liveAccounts = new Map<string, { role: Role; status: string; at: number }>()
const LIVE_ACCOUNT_TTL_MS = 10_000

export function forgetLiveAccount(id: string) { liveAccounts.delete(id) }

async function liveAccount(id: string) {
  const cached = liveAccounts.get(id)
  if (cached && Date.now() - cached.at < LIVE_ACCOUNT_TTL_MS) return cached
  const row = (await query<{ role: Role; status: string }>('select role, status from users where id = $1', [id])).rows[0]
  if (!row) return null
  const entry = { role: row.role, status: row.status, at: Date.now() }
  liveAccounts.set(id, entry)
  return entry
}

export async function getSessionFromCookie() {
  const store = await cookies()
  const token = store.get(COOKIE_NAME)?.value
  if (!token) return null
  let session: SessionUser
  try {
    session = verifySession(token)
  } catch {
    return null
  }
  const account = await liveAccount(session.id)
  if (!account || account.status !== 'active') return null
  return { ...session, role: account.role }
}
