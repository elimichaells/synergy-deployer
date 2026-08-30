import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'

export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) {
    return NextResponse.json({ user: null }, { status: 401 })
  }
  return NextResponse.json({ user })
}
