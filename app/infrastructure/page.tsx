'use client'

import { AppShell } from '@/components/layout/app-shell'
import { infrastructureItems } from '@/components/synergy/nav'
import { InfrastructureOverview } from '@/components/workspace/infrastructure-overview'
import { useEffect, useState } from 'react'

interface Summary { servers: number; healthy: number; databases: number; domains: number; processes: number; online: number }

export default function InfrastructurePage() {
  const [summary, setSummary] = useState<Summary | null>(null)

  useEffect(() => {
    void Promise.all([
      fetch('/api/data/connections').then(response => response.ok ? response.json() : { connections: [] }),
      fetch('/api/data/services').then(response => response.ok ? response.json() : { services: [] }),
      fetch('/api/domains').then(response => response.ok ? response.json() : { domains: [] }),
      fetch('/api/services').then(response => response.ok ? response.json() : []),
    ]).then(([connections, services, domains, processes]) => {
      const list = Array.isArray(processes) ? processes : processes.services || processes.processes || []
      setSummary({
        servers: (connections.connections || []).length,
        healthy: (connections.connections || []).filter((item: { last_status: string }) => item.last_status === 'healthy').length,
        databases: (services.services || []).length,
        domains: (domains.domains || []).length,
        processes: list.length,
        online: list.filter((item: { status?: string; pm2_env?: { status?: string } }) => (item.status || item.pm2_env?.status) === 'online').length,
      })
    }).catch(() => setSummary(null))
  }, [])

  const facts: Record<string, string | null> = summary ? {
    '/domains': `${summary.domains} domains`,
    '/services': `${summary.online}/${summary.processes} processes online`,
  } : {}

  return (
    <AppShell title="Infrastructure" subtitle="Server-wide services that every project relies on." area="infrastructure">
      <InfrastructureOverview projectsHref="/projects" items={infrastructureItems} facts={facts} />
    </AppShell>
  )
}
