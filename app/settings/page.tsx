'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { AppShell } from '@/components/layout/app-shell'
import { Save, Check, Github, Copy, Loader2, Unlink } from 'lucide-react'

interface SessionUser {
  id: string
  email: string
  name: string
  role: 'admin' | 'operator' | 'viewer'
}

interface UserRow {
  id: string
  email: string
  name: string
  role: string
  status: string
  created_at: string
  last_login_at: string | null
}

interface Settings {
  PRODUCTION_PATH: string
  STAGING_PATH: string
  LOGS_PATH: string
  CADDY_PATH: string
  GITHUB_TOKEN: string
}

const EMPTY_SETTINGS: Settings = {
  PRODUCTION_PATH: '',
  STAGING_PATH: '',
  LOGS_PATH: '',
  CADDY_PATH: '',
  GITHUB_TOKEN: '',
}

function GitHubConnection({ isAdmin }: { isAdmin: boolean }) {
  const [status, setStatus] = useState<'idle' | 'requesting' | 'waiting' | 'polling' | 'connected' | 'error'>('idle')
  const [userCode, setUserCode] = useState('')
  const [verificationUri, setVerificationUri] = useState('')
  const [deviceCode, setDeviceCode] = useState('')
  const [interval, setIntervalMs] = useState(5)
  const [githubUser, setGithubUser] = useState<{ login: string; name: string; avatar: string } | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [copied, setCopied] = useState(false)
  const [hasToken, setHasToken] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  // Check if a token exists on mount
  useEffect(() => {
    fetch('/api/settings').then(r => r.ok ? r.json() : null).then(data => {
      if (data?.GITHUB_TOKEN) setHasToken(true)
    }).catch(() => { })
  }, [])

  const startFlow = async () => {
    setStatus('requesting')
    setErrorMsg('')
    try {
      const res = await fetch('/api/auth/github/device', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to start')

      setUserCode(data.userCode)
      setVerificationUri(data.verificationUri)
      setDeviceCode(data.deviceCode)
      setIntervalMs(data.interval || 5)
      setStatus('waiting')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to start device flow')
      setStatus('error')
    }
  }

  const openGitHub = () => {
    window.open(verificationUri, '_blank')
    setStatus('polling')
    pollForToken()
  }

  const pollForToken = async () => {
    const pollInterval = (interval + 1) * 1000
    const maxAttempts = 60

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, pollInterval))

      try {
        const res = await fetch('/api/auth/github/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceCode }),
        })
        const data = await res.json()

        if (data.status === 'success') {
          setGithubUser(data.githubUser)
          setHasToken(true)
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

        // authorization_pending or slow_down — keep polling
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

  const handleDisconnect = async () => {
    setDisconnecting(true)
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ GITHUB_TOKEN: '' }),
      })
      setHasToken(false)
      setGithubUser(null)
      setStatus('idle')
    } catch {
      // ignore
    } finally {
      setDisconnecting(false)
    }
  }

  if (!isAdmin) {
    return (
      <div className="rounded-lg border border-[#2a2a31] bg-[#0f0f14] p-4">
        <p className="text-sm text-[#b8bac0]">GitHub: {hasToken ? 'Connected' : 'Not connected'}</p>
      </div>
    )
  }

  // Connected state
  if (hasToken && status !== 'waiting' && status !== 'polling' && status !== 'requesting') {
    return (
      <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500/10">
              <Github className="h-5 w-5 text-emerald-400" />
            </div>
            <div>
              <p className="text-sm font-medium text-emerald-300">
                {githubUser ? `Connected as ${githubUser.login}` : 'GitHub Connected'}
              </p>
              <p className="text-[11px] text-emerald-400/60">Token stored securely in database</p>
            </div>
          </div>
          <button
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="flex items-center gap-1.5 rounded-md border border-red-500/20 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-50"
          >
            <Unlink className="h-3 w-3" />
            {disconnecting ? 'Disconnecting...' : 'Disconnect'}
          </button>
        </div>
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
            <p className="text-sm font-medium text-[#ededed] mb-1">Enter this code on GitHub</p>
            <div className="flex items-center justify-center gap-2">
              <code className="text-2xl font-bold tracking-[0.3em] text-blue-300 bg-blue-500/10 px-4 py-2 rounded-lg border border-blue-500/20">
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
            onClick={() => setStatus('idle')}
            className="text-xs text-[#9ea0a6] hover:text-[#ededed] transition-colors"
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
      </div>
    )
  }

  // Idle / Requesting state
  return (
    <div className="rounded-lg border border-[#2a2a31] bg-[#0f0f14] p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-[#ededed] mb-0.5">GitHub</p>
          <p className="text-[11px] text-[#9ea0a6]">Connect your GitHub account for automated deployments.</p>
        </div>
        <Button
          onClick={startFlow}
          disabled={status === 'requesting'}
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
    </div>
  )
}

export default function SettingsPage() {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [users, setUsers] = useState<UserRow[]>([])
  const [settings, setSettings] = useState<Settings>(EMPTY_SETTINGS)
  const [form, setForm] = useState<Settings>(EMPTY_SETTINGS)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      try {
        const meRes = await fetch('/api/auth/me')
        const meData = meRes.ok ? await meRes.json() : { user: null }
        setUser(meData.user)

        const settingsRes = await fetch('/api/settings')
        if (settingsRes.ok) {
          const data = await settingsRes.json()
          setSettings(data)
          setForm(data)
        }

        if (meData.user?.role === 'admin') {
          const usersRes = await fetch('/api/users')
          if (usersRes.ok) {
            const usersData = await usersRes.json()
            setUsers(usersData)
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load settings')
      }
    }
    void load()
  }, [])

  const isAdmin = user?.role === 'admin'
  const hasChanges = JSON.stringify(form) !== JSON.stringify(settings)

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to save settings')
      }
      setSettings({ ...form })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  const inputClass =
    'w-full rounded-lg border border-[#2a2a31] bg-[#0f0f14] px-3 py-2 text-sm text-[#ededed] outline-none focus:border-[#4a4a55] disabled:opacity-50 disabled:cursor-not-allowed'

  return (
    <AppShell
      title="Settings"
      subtitle="Manage system configuration and access."
      user={{ name: user?.name, role: user?.role }}
      actions={null}
    >
      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {saved && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
          <Check className="h-4 w-4" />
          Settings saved successfully.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        {/* System Settings */}
        <Card className="surface-card">
          <CardHeader>
            <CardTitle className="text-[#f0f0f0]">System Settings</CardTitle>
            <CardDescription className="text-[#b8bac0]">
              Server paths and integration tokens.{' '}
              {!isAdmin && <span className="text-amber-400/80">View only — admin access required to edit.</span>}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Paths Section */}
            <div>
              <h4 className="mb-3 text-xs font-medium uppercase tracking-wider text-[#9ea0a6]">Paths</h4>
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs text-[#b8bac0]">Production Path</label>
                  <input
                    type="text"
                    className={inputClass}
                    value={form.PRODUCTION_PATH}
                    onChange={(e) => setForm({ ...form, PRODUCTION_PATH: e.target.value })}
                    disabled={!isAdmin}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-[#b8bac0]">Staging Path</label>
                  <input
                    type="text"
                    className={inputClass}
                    value={form.STAGING_PATH}
                    onChange={(e) => setForm({ ...form, STAGING_PATH: e.target.value })}
                    disabled={!isAdmin}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-[#b8bac0]">Logs Path</label>
                  <input
                    type="text"
                    className={inputClass}
                    value={form.LOGS_PATH}
                    onChange={(e) => setForm({ ...form, LOGS_PATH: e.target.value })}
                    disabled={!isAdmin}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-[#b8bac0]">Caddy Path</label>
                  <input
                    type="text"
                    className={inputClass}
                    value={form.CADDY_PATH}
                    onChange={(e) => setForm({ ...form, CADDY_PATH: e.target.value })}
                    disabled={!isAdmin}
                  />
                </div>
              </div>
            </div>

            {/* Integrations Section */}
            <div>
              <h4 className="mb-3 text-xs font-medium uppercase tracking-wider text-[#9ea0a6]">Integrations</h4>
              <GitHubConnection isAdmin={isAdmin} />
            </div>

            {/* Save Button */}
            {isAdmin && (
              <div className="flex items-center gap-3 pt-2">
                <Button
                  onClick={handleSave}
                  disabled={saving || !hasChanges}
                  className="gap-2"
                >
                  <Save className="h-4 w-4" />
                  {saving ? 'Saving...' : 'Save Settings'}
                </Button>
                {hasChanges && (
                  <span className="text-xs text-amber-400/80">Unsaved changes</span>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Right Column */}
        <div className="space-y-6">
          <Card className="surface-card">
            <CardHeader>
              <CardTitle className="text-[#f0f0f0]">Account</CardTitle>
              <CardDescription className="text-[#b8bac0]">
                Signed-in user details.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-1 text-sm text-[#ededed]">
              <p>Name: {user?.name}</p>
              <p>Email: {user?.email}</p>
              <p>Role: {user?.role}</p>
            </CardContent>
          </Card>

          <Card className="surface-card">
            <CardHeader>
              <CardTitle className="text-[#f0f0f0]">Database</CardTitle>
              <CardDescription className="text-[#b8bac0]">
                Connection configured via environment.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-1 text-xs text-[#b8bac0]">
              <p>These settings remain in .env.local:</p>
              <p className="font-mono text-[#9ea0a6]">DATABASE_HOST, DATABASE_PORT, DATABASE_NAME</p>
              <p className="font-mono text-[#9ea0a6]">DATABASE_USER, DATABASE_PASSWORD, JWT_SECRET</p>
              <div className="pt-2">
                <Link href="/services" className="text-[#d6d7db] underline">
                  Manage services and Caddy
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Users Section */}
      {isAdmin && (
        <Card className="mt-6 surface-card">
          <CardHeader>
            <CardTitle className="text-[#f0f0f0]">Users</CardTitle>
            <CardDescription className="text-[#b8bac0]">
              Admin-only user list.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {users.length === 0 ? (
              <p className="text-sm text-[#b8bac0]">No users found.</p>
            ) : (
              users.map((row) => (
                <div
                  key={row.id}
                  className="rounded-lg border border-[#2a2a31] bg-[#0f0f14] p-3 text-xs text-[#ededed]"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-[#f0f0f0]">{row.name}</p>
                      <p className="text-[11px] text-[#9ea0a6]">{row.email}</p>
                    </div>
                    <div className="text-right text-[11px] text-[#9ea0a6]">
                      <p>{row.role}</p>
                      <p>{row.status}</p>
                    </div>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      )}
    </AppShell>
  )
}
