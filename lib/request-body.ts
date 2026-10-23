import { ApiError } from '@/lib/api'

export function requireSameOrigin(request: Request) {
  if (process.env.MANAGER_PREVIEW === '1') throw new ApiError('Preview is read-only', 503)
  const origin = request.headers.get('origin')
  let valid = false
  try { valid = !!origin && new URL(origin).host === request.headers.get('host') } catch { /* Reject malformed origins. */ }
  if (!valid || request.headers.get('sec-fetch-site') === 'cross-site') throw new ApiError('A same-origin request is required', 403)
}

export async function readBody(request: Request, max = 200_000): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('content-length') || 0) > max) throw new ApiError('Request is too large', 413)
  const reader = request.body?.getReader()
  if (!reader) throw new ApiError('JSON body required', 400)
  let size = 0
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) { await reader.cancel(); throw new ApiError('Request is too large', 413) }
    chunks.push(value)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
    return body
  } catch { throw new ApiError('Invalid JSON body', 400) }
}

