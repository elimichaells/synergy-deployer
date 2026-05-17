import { Role, SessionUser } from './auth'
import { ApiError } from './api'

export function requireRole(user: SessionUser | null, allowed: Role[]) {
  if (!user) {
    throw new ApiError('Unauthorized', 401)
  }
  if (!allowed.includes(user.role)) {
    throw new ApiError('Forbidden', 403)
  }
}
