'use client'

import { AppShell } from '@/components/layout/app-shell'
import { type DeploymentSummary } from '@/components/synergy/deployment-row'
import { Button } from '@/components/ui/button'
import { DeploymentHistory } from '@/components/workspace/deployment-history'
import { cn } from '@/lib/utils'
import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

interface SessionUser {
  id: string
  email: string
  name: string
  role: 'admin' | 'operator' | 'viewer'
}

export default function DeploymentsPage() {
  const [deployments, setDeployments] = useState<DeploymentSummary[]>([])
  const [user, setUser] = useState<SessionUser | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(() => Date.now())

  const loadDeployments = useCallback(async (silent = false) => {
    if (!silent) setError(null)
    try {
      const response = await fetch('/api/deployments?limit=100', { cache: 'no-store' })
      if (!response.ok) throw new Error('Failed to load deployments')
      setDeployments(await response.json())
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : 'Failed to load deployments')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadDeployments()
    void fetch('/api/auth/me')
      .then((response) => response.ok ? response.json() : { user: null })
      .then((data) => setUser(data.user))
    const refreshTimer = window.setInterval(() => { if (!document.hidden) void loadDeployments(true) }, 5_000)
    const clock = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => { window.clearInterval(refreshTimer); window.clearInterval(clock) }
  }, [loadDeployments])

  return (
    <AppShell
      title="Deployments"
      subtitle="Every release across this host, with its full pipeline and build output."
      user={{ name: user?.name, role: user?.role }}
      actions={<Button variant="outline" size="sm" onClick={() => void loadDeployments()}><RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />Refresh</Button>}
    >
      {error && <div role="alert" className="notice-error">{error}</div>}

      <DeploymentHistory deployments={deployments} now={now} loading={loading} />
    </AppShell>
  )
}
