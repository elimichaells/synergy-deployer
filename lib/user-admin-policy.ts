export const USER_ROLES = ['admin', 'operator', 'viewer'] as const
export type UserRole = typeof USER_ROLES[number]
export const USER_STATUSES = ['active', 'disabled'] as const
export type UserStatus = typeof USER_STATUSES[number]
export const MIN_PASSWORD_LENGTH = 12

export function validatePassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) throw new Error(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters`)
  if (password.length > 200) throw new Error('That password is too long')
  return password
}

export function validateNewUser(body: Record<string, unknown> | null) {
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new Error('Enter a valid email address')
  if (!name || name.length > 120) throw new Error('Enter the person\'s name')
  if (!USER_ROLES.includes(body?.role as UserRole)) throw new Error('Choose a role: administrator, operator or viewer')
  return { email, name, role: body!.role as UserRole, password: validatePassword(body?.password) }
}

export interface MemberChange {
  actorId: string
  target: { id: string; role: string; status: string }
  role?: unknown
  status?: unknown
  /** Active administrators on the team right now, including the target if it is one. */
  activeAdmins: number
}

/** Validates a role or status change; throws a message the admin can act on. */
export function checkMemberChange(change: MemberChange): { role?: UserRole; status?: UserStatus } {
  const result: { role?: UserRole; status?: UserStatus } = {}
  if (change.role !== undefined) {
    if (!USER_ROLES.includes(change.role as UserRole)) throw new Error('Unknown role')
    result.role = change.role as UserRole
  }
  if (change.status !== undefined) {
    if (!USER_STATUSES.includes(change.status as UserStatus)) throw new Error('Unknown status')
    result.status = change.status as UserStatus
  }
  if (!result.role && !result.status) throw new Error('Nothing to change')
  const self = change.actorId === change.target.id
  if (self && result.role && result.role !== change.target.role) throw new Error('You cannot change your own role. Ask another administrator.')
  if (self && result.status === 'disabled') throw new Error('You cannot disable your own account. Ask another administrator.')
  const losesAdmin = change.target.role === 'admin' && change.target.status === 'active'
    && ((result.role && result.role !== 'admin') || result.status === 'disabled')
  if (losesAdmin && change.activeAdmins <= 1) throw new Error('Synergy needs at least one active administrator')
  return result
}
