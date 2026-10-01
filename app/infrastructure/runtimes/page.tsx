'use client'

import { useEffect, useState } from 'react'
import { AppShell } from '@/components/layout/app-shell'
import { RuntimeManager } from '@/components/runtime-manager'

export default function RuntimesPage() {
  const [role, setRole] = useState<string | null>(null)
  useEffect(() => {
    void fetch('/api/auth/me').then(response => response.ok ? response.json() : null).then(body => setRole(body?.user?.role || 'viewer')).catch(() => setRole('viewer'))
  }, [])
  return (
    <AppShell title="Runtimes & tools" subtitle="Language runtimes, database engines and tools installed on this server. Apps pin their own versions in their settings." area="infrastructure">
      {role === null ? <div className="h-64 animate-pulse rounded-xl border border-border bg-card" /> : <RuntimeManager isAdmin={role === 'admin'} workspace />}
    </AppShell>
  )
}
