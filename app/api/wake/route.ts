import { wakeByHost } from '@/lib/staging-sleep'

export const dynamic = 'force-dynamic'

const escape = (value: string) => value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)

function page(starting: boolean, host: string) {
  const title = starting ? 'Starting up' : 'Temporarily unavailable'
  const message = starting
    ? 'This staging site was asleep to save memory on the server. It is starting now, and this page reloads by itself in a few seconds.'
    : 'This site is not responding right now. Please try again in a moment.'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${starting ? '<meta http-equiv="refresh" content="8">' : ''}<meta name="robots" content="noindex"><title>${title}</title>
<style>:root{color-scheme:light dark;--bg:#fafafa;--fg:#111;--muted:#666;--line:#e5e5e5}@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--fg:#ededed;--muted:#a1a1a1;--line:#262626}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:28rem;padding:2rem 1.5rem;text-align:center}h1{font-size:1.25rem;margin:1rem 0 .5rem}p{color:var(--muted);margin:0}small{display:block;margin-top:1.5rem;color:var(--muted)}
.dot{width:12px;height:12px;border-radius:50%;margin:0 auto;background:${starting ? '#22c55e' : '#f59e0b'};${starting ? 'animation:pulse 1.2s ease-in-out infinite' : ''}}
@keyframes pulse{50%{opacity:.25}}@media (prefers-reduced-motion:reduce){.dot{animation:none}}</style></head>
<body><main><div class="dot" aria-hidden="true"></div><h1>${title}</h1><p>${message}</p>${host ? `<small>${escape(host)}</small>` : ''}</main></body></html>`
}

/**
 * Caddy sends a visit here when a sleeping staging app cannot answer. It needs no session: it can
 * only start an app that has sleeping turned on, and it reveals nothing about the server.
 */
async function handle(request: Request) {
  const host = new URL(request.url).searchParams.get('host') || ''
  const state = await wakeByHost(host).catch(() => 'unknown' as const)
  const starting = state === 'starting'
  return new Response(request.method === 'HEAD' ? null : page(starting, starting ? host : ''), {
    status: starting ? 503 : 502,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '10', 'X-Robots-Tag': 'noindex' },
  })
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as HEAD }
