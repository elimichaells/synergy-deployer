'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Check, Github, Copy, Loader2, Trash2, RefreshCw, Plus } from 'lucide-react'

interface GitHubConnectionRow {
  id: string
  name: string
  account_login: string
  account_name: string | null
  avatar_url: string | null
  token_last_four: string
  token_scopes: string[]
  last_validated_at: string | null
  last_error: string | null
  project_count: number
}

export function GitHubConnections({ isAdmin }: { isAdmin: boolean }) {
  const [status, setStatus] = useState<'idle' | 'requesting' | 'waiting' | 'polling' | 'connected' | 'error'>('idle')
  const [userCode, setUserCode] = useState('')
  const [verificationUri, setVerificationUri] = useState('')
  const [deviceCode, setDeviceCode] = useState('')
  const [interval, setIntervalMs] = useState(5)
  const [errorMsg, setErrorMsg] = useState('')
  const [copied, setCopied] = useState(false)
  const [hasToken, setHasToken] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [connections, setConnections] = useState<GitHubConnectionRow[]>([])
  const [connectionName, setConnectionName] = useState('')
  const [connectionBusy, setConnectionBusy] = useState<string | null>(null)
  const [showConnectForm, setShowConnectForm] = useState(false)
  const flowGeneration = useRef({ value: 0 })

  const loadConnections = async () => {
    const response = await fetch('/api/github/connections')
    if (!response.ok) throw new Error('Unable to load GitHub connections')
    const data = await response.json()
    const nextConnections = data.connections || []
    setConnections(nextConnections)
    setHasToken(nextConnections.length > 0)
  }

  useEffect(() => {
    const generation = flowGeneration.current
    void loadConnections().catch(error => setErrorMsg(error.message))
    return () => { generation.value++ }
  }, [])

  const startFlow = async () => {
    if (!connectionName.trim()) {
      setErrorMsg('Enter a name for this GitHub connection.')
      setStatus('error')
      return
    }
    setStatus('requesting')
    setErrorMsg('')
    const generation = ++flowGeneration.current.value
    try {
      const res = await fetch('/api/auth/github/device', { method: 'POST' })
      const data = await res.json()
      if (generation !== flowGeneration.current.value) return
      if (!res.ok) throw new Error(data.error || 'Failed to start')

      setUserCode(data.userCode)
      setVerificationUri(data.verificationUri)
      setDeviceCode(data.deviceCode)
      setIntervalMs(data.interval || 5)
      setStatus('waiting')
    } catch (err) {
      if (generation !== flowGeneration.current.value) return
      setErrorMsg(err instanceof Error ? err.message : 'Failed to start device flow')
      setStatus('error')
    }
  }

  const openGitHub = () => {
    window.open(verificationUri, '_blank', 'noopener,noreferrer')
    setStatus('polling')
    pollForToken()
  }

  const pollForToken = async () => {
    const generation = flowGeneration.current.value
    let pollInterval = (interval + 1) * 1000
    const maxAttempts = 60

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, pollInterval))
      if (generation !== flowGeneration.current.value) return

      try {
        const res = await fetch('/api/auth/github/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceCode, connectionName: connectionName.trim() }),
        })
        const data = await res.json()
        if (generation !== flowGeneration.current.value) return
        if (!res.ok) {
          setErrorMsg(data.error || 'GitHub authorization failed')
          setStatus('error')
          return
        }

        if (data.status === 'success') {
          await loadConnections()
          setConnectionName('')
          setShowConnectForm(false)
          setStatus('connected')
          return
        }

        if (data.status === 'expired_token') {
          setErrorMsg('Code expired. Please try again.')
          setStatus('error')
          return
        }

        if (data.status === 'access_denied') {
          setErrorMsg('Authorization was denied.')
          setStatus('error')
          return
        }

        if (data.status === 'slow_down') pollInterval += 5000
      } catch {
        // Network error — keep trying
      }
    }

    setErrorMsg('Timed out waiting for authorization.')
    setStatus('error')
  }

  const handleCopyCode = async () => {
    await navigator.clipboard.writeText(userCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleDisconnect = async (connection: GitHubConnectionRow) => {
    if (!window.confirm(`Remove GitHub connection "${connection.name}"?`)) return
    setDisconnecting(true)
    setConnectionBusy(connection.id)
    setErrorMsg('')
    try {
      const response = await fetch(`/api/github/connections/${connection.id}`, { method: 'DELETE' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Failed to remove GitHub connection')
      await loadConnections()
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : 'Failed to remove GitHub connection')
    } finally {
      setDisconnecting(false)
      setConnectionBusy(null)
    }
  }

  const handleTestConnection = async (connection: GitHubConnectionRow) => {
    setConnectionBusy(connection.id)
    setErrorMsg('')
    try {
      const response = await fetch(`/api/github/connections/${connection.id}/test`, { method: 'POST' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'GitHub connection test failed')
      await loadConnections()
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : 'GitHub connection test failed')
    } finally {
      setConnectionBusy(null)
    }
  }

  if (!isAdmin) {
    return (
      <div className="rounded-lg border border-white/10 bg-black/30 p-4">
        <p className="text-sm text-muted-foreground">GitHub: {hasToken ? 'Connected' : 'Not connected'}</p>
      </div>
    )
  }

  // Connected state
  if (hasToken && !showConnectForm && status !== 'waiting' && status !== 'polling' && status !== 'requesting') {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h3 className="text-sm font-semibold">GitHub accounts</h3><p className="mt-1 text-xs text-muted-foreground">{connections.length} connected account{connections.length === 1 ? '' : 's'}</p></div>
          <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => { setShowConnectForm(true); setStatus('idle'); setErrorMsg('') }}>
            <Plus className="h-3.5 w-3.5" /> Add connection
          </Button>
        </div>
        <div className="divide-y divide-border border-y border-border">
          {connections.map((connection) => (
            <div key={connection.id} className="flex flex-wrap items-center gap-3 py-4">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-xs font-semibold uppercase">{connection.account_login.slice(0, 1)}</div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{connection.name}</p>
                <p className="break-words text-xs text-muted-foreground">@{connection.account_login} · {connection.project_count} project{connection.project_count === 1 ? '' : 's'}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">Token ending {connection.token_last_four}</p>
                {connection.last_error && <p className="mt-1 text-[11px] text-red-400">{connection.last_error}</p>}
              </div>
              <button type="button" title="Test connection" aria-label={`Test ${connection.name}`} onClick={() => void handleTestConnection(connection)} disabled={!!connectionBusy} className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40">
                <RefreshCw className={`h-4 w-4 ${connectionBusy === connection.id ? 'animate-spin' : ''}`} />
              </button>
              <button type="button" title={connection.project_count ? 'Reassign projects before removing' : 'Remove connection'} aria-label={`Remove ${connection.name}`} onClick={() => void handleDisconnect(connection)} disabled={disconnecting || connection.project_count > 0} className="rounded-md p-2 text-muted-foreground hover:bg-red-500/10 hover:text-red-400 disabled:opacity-40">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
        {errorMsg && <p className="text-xs text-red-400">{errorMsg}</p>}
      </div>
    )
  }

  // Waiting / Polling state — show user code
  if (status === 'waiting' || status === 'polling') {
    return (
      <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-5">
        <div className="text-center space-y-4">
          <Github className="h-8 w-8 text-blue-400 mx-auto" />
          <div>
            <p className="text-sm font-medium text-foreground mb-1">Enter this code on GitHub</p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <code className="rounded-md border border-border bg-muted px-3 py-2 text-xl font-semibold text-foreground">
                {userCode}
              </code>
              <button
                onClick={handleCopyCode}
                className="rounded-md p-2 text-blue-400 hover:bg-blue-500/10 transition-colors"
                title="Copy code"
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {status === 'waiting' ? (
            <Button onClick={openGitHub} className="gap-2">
              <Github className="h-4 w-4" />
              Open GitHub
            </Button>
          ) : (
            <div className="flex items-center justify-center gap-2 text-sm text-blue-300">
              <Loader2 className="h-4 w-4 animate-spin" />
              Waiting for authorization...
            </div>
          )}

          <button
            onClick={() => { flowGeneration.current.value++; setStatus('idle'); setShowConnectForm(false) }}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  // Error state
  if (status === 'error') {
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4">
        <p className="text-sm text-red-400 mb-3">{errorMsg}</p>
        <Button onClick={startFlow} variant="outline" size="sm" className="gap-2">
          <Github className="h-4 w-4" />
          Try Again
        </Button>
        <Button variant="ghost" size="sm" onClick={() => { flowGeneration.current.value++; setStatus('idle'); setShowConnectForm(false); setErrorMsg('') }}>Cancel</Button>
      </div>
    )
  }

  // Idle / Requesting state
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 p-4 space-y-3">
      <div>
        <p className="text-sm text-foreground mb-0.5">New GitHub connection</p>
        <p className="text-[11px] text-muted-foreground">Give this account a recognizable name, then authorize it with GitHub.</p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input aria-label="GitHub connection name" value={connectionName} onChange={(event) => setConnectionName(event.target.value)} placeholder="Connection name" disabled={status === 'requesting'} className="control-input flex-1" />
        <Button
          onClick={startFlow}
          disabled={status === 'requesting' || !connectionName.trim()}
          variant="outline"
          size="sm"
          className="gap-2"
        >
          {status === 'requesting' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Github className="h-4 w-4" />
          )}
          Connect GitHub
        </Button>
      </div>
      {hasToken && <button type="button" onClick={() => { setShowConnectForm(false); setStatus('connected'); setErrorMsg('') }} className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>}
      {errorMsg && <p role="alert" className="text-xs text-red-400">{errorMsg}</p>}
    </div>
  )
}
