'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

export function GitHubApplication() {
  const [clientId, setClientId] = useState('')
  const [saved, setSaved] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    let active = true
    fetch('/api/settings').then(async response => {
      if (!response.ok) throw new Error('Unable to load GitHub application settings.')
      const settings = await response.json()
      if (active) { setClientId(settings.GITHUB_CLIENT_ID || ''); setSaved(settings.GITHUB_CLIENT_ID || ''); setLoaded(true) }
    }).catch(error => { if (active) setMessage(error.message) })
    return () => { active = false }
  }, [])
  const save = async () => {
    setBusy(true); setMessage('')
    try {
      const response = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ GITHUB_CLIENT_ID: clientId.trim() }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not save GitHub application settings.')
      setSaved(clientId.trim()); setClientId(clientId.trim()); setMessage('Saved in the database. You can connect a GitHub account now.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save settings.') }
    finally { setBusy(false) }
  }
  return <details className="rounded-md border border-border p-3" open={loaded && !saved ? true : undefined}>
    <summary className="cursor-pointer text-sm font-medium">GitHub application</summary>
    <p className="mt-2 text-xs text-muted-foreground">Enter the client ID from your GitHub OAuth app and enable device flow in that app. Saved in Manager’s database; no server restart is needed. This sign-in method does not require a client secret.</p>
    <label className="mt-3 block text-xs font-medium" htmlFor="github-application-client-id">OAuth client ID</label>
    <div className="mt-1 flex flex-wrap gap-2"><input id="github-application-client-id" className="control-input min-w-48 flex-1" value={clientId} onChange={event => setClientId(event.target.value)} disabled={!loaded || busy} maxLength={128} autoComplete="off" /><Button type="button" size="sm" onClick={() => void save()} disabled={!loaded || busy || saved === clientId.trim()}>{busy ? 'Saving…' : 'Save client ID'}</Button></div>
    {message && <p role="status" className="mt-2 text-xs text-muted-foreground">{message}</p>}
  </details>
}
