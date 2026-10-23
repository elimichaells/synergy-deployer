import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { maintenance } from './scripts/manager-update-state.cjs'

const COOKIE_NAME = 'manager_session'

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (maintenance() && pathname !== '/api/manager-updates' && pathname !== '/api/auth/login' && pathname !== '/api/auth/logout' && (!['GET','HEAD','OPTIONS'].includes(request.method) || pathname === '/api/wake')) {
    return NextResponse.json({ error: 'Manager is updating. Please retry shortly.' }, { status: 503, headers: { 'Retry-After': '30' } })
  }
  if (process.env.MANAGER_PREVIEW === '1' && (pathname === '/api/wake' || !['GET', 'HEAD', 'OPTIONS'].includes(request.method))) {
    return NextResponse.json({ error: 'This release preview is read-only.' }, { status: 503, headers: { 'Retry-After': '30' } })
  }

  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/api/auth') ||
    pathname === '/api/manager-health' ||
    pathname.startsWith('/api/webhooks') ||
    // These routes authenticate a scoped agent credential (enrollment consumes a one-time token).
    pathname.startsWith('/api/server-agent/') ||
    // A visit to a sleeping staging app is sent here by Caddy to wake it; it needs no session.
    pathname === '/api/wake' ||
    pathname === '/login'
  ) {
    return NextResponse.next()
  }

  const token = request.cookies.get(COOKIE_NAME)?.value

  if (pathname.startsWith('/api')) {
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return NextResponse.next()
  }

  if (!token) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  runtime: 'nodejs',
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
