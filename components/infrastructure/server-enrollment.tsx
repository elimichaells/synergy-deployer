'use client'

import { useEffect, useState } from 'react'

export function ServerEnrollment({ id, token, platform, onDismiss }: { id: string; token: string; platform: string; onDismiss: () => void }) {
  const [origin, setOrigin] = useState('https://manager.example.edu')
  useEffect(() => setOrigin(window.location.origin), [])
  const root = platform === 'win32' ? 'C:\\ManagerAgent' : '/var/lib/manager-agent'
  const validOrigin = /^https:\/\/[a-z0-9.[\]:-]+$/i.test(origin)
  const command = validOrigin ? `node manager-agent.cjs enroll --root "${root}" --manager "${origin}" --server "${id}"` : 'Enter a reachable HTTPS address above to generate the enrollment command.'
  return <section className="space-y-4 rounded-xl border border-syn-violet/40 bg-card p-5" aria-label="Enroll this server">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">Connect this server</h2><button type="button" className="text-xs underline" onClick={onDismiss}>Hide token</button></div>
    <label className="block text-sm">Manager HTTPS address reachable from this server<input type="url" className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={origin} onChange={e => setOrigin(e.target.value.replace(/\/$/, ''))} /></label>
    {!validOrigin && <p className="text-xs text-amber-200">Use the Manager HTTPS hostname reachable from the target network. A browser-local address such as localhost cannot connect a different server.</p>}
    <ol className="list-decimal space-y-3 pl-5 text-sm">
      <li>On the target server, install Node.js 22 or later, Git, PM2 and Caddy. Use a dedicated account and data folder for the agent.</li>
      <li><a href="/api/servers/agent" download="manager-agent.cjs" className="underline">Download manager-agent.cjs</a> and copy it to that server. The server must be able to reach <span className="break-all font-mono">{origin}</span> over HTTPS.</li>
      <li>Run this command in the folder containing the downloaded file:<pre className="mt-2 overflow-x-auto rounded-lg bg-black/40 p-3 text-xs">{command}</pre></li>
      <li>Paste this one-time token when prompted. It expires in one hour:<pre className="mt-2 overflow-x-auto rounded-lg bg-black/40 p-3 text-xs">{token}</pre></li>
      <li>Start the agent:<pre className="mt-2 overflow-x-auto rounded-lg bg-black/40 p-3 text-xs">{`node manager-agent.cjs run --root "${root}"`}</pre></li>
    </ol>
    <p className="text-xs leading-5 text-muted-foreground">Configure the agent to start at boot using Windows Task Scheduler or a Linux systemd service. Keep the same account and data directory. The agent uses a separate PM2 home and manages its own Caddy configuration; ports 80, 443 and 2029 must be available. Existing Caddy installations need a planned migration before enrollment for deployments.</p>
    <p className="text-xs leading-5 text-muted-foreground">For an institution-issued Manager certificate, trust its CA on the target server and set NODE_EXTRA_CA_CERTS to the public CA file before starting Node. Do not disable TLS verification. This connection needs outbound HTTPS only.</p>
  </section>
}
