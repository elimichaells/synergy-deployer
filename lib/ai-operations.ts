import { readFile, stat } from 'fs/promises'
import path from 'path'
import { managerDataRoot } from '@/lib/paths'
import { summarizeUptime } from '../scripts/uptime-history.cjs'
import { NextResponse } from 'next/server'
import { ApiError } from '@/lib/api'

export async function readUptime(range: string) {
  const state = process.env.MANAGER_HEALTH_STATE_FILE || path.join(managerDataRoot(), 'monitor', 'state.json')
  const file = process.env.MANAGER_UPTIME_FILE || path.join(path.dirname(state), 'uptime.json')
  try {
    if ((await stat(file)).size > 12 * 1024 ** 2) throw Error('Uptime data exceeds limit')
    const result = summarizeUptime(JSON.parse(await readFile(file, 'utf8')), range)
    return { ...result, unavailable: false, stale: !result.checkedAt || Date.now() - result.checkedAt > 180000 }
  } catch { return { ...summarizeUptime(null, range), unavailable: true, stale: true } }
}
export function requireSameOrigin(request: Request) {
  if (process.env.MANAGER_PREVIEW === '1') throw new ApiError('Preview is read-only', 503)
  const origin = request.headers.get('origin')
  let valid = false
  try { valid = !!origin && new URL(origin).host === request.headers.get('host') } catch { /* Invalid Origin is rejected. */ }
  if (!valid || request.headers.get('sec-fetch-site') === 'cross-site') throw new ApiError('A same-origin review request is required', 403)
}
export function operationsError(error: unknown) {
  return NextResponse.json({ error: error instanceof ApiError ? error.message : 'Operations data is unavailable. Check the Manager connection and try again.' }, { status: error instanceof ApiError ? error.status : 503 })
}
export async function operationsBody(request: Request) {
  const reader = request.body?.getReader()
  if (!reader) throw new ApiError('Invalid request', 400)
  const decoder = new TextDecoder()
  let text = '', size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > 6000) throw new ApiError('Request is too large', 413)
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
  } finally { await reader.cancel().catch(() => {}) }
  let body
  try { body = JSON.parse(text) } catch { throw new ApiError('Invalid request', 400) }
  if (!body || Array.isArray(body) || typeof body !== 'object') throw new ApiError('Invalid request', 400)
  return body
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new ApiError('Invalid application or review ID', 400)
  return value
}
