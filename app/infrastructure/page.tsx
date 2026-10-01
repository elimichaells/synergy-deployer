'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Boxes } from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import { infrastructureItems } from '@/components/synergy/nav'

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
      <div className="mb-6 flex items-start gap-3 rounded-xl border border-border bg-card p-5">
        <Boxes className="mt-0.5 h-5 w-5 shrink-0 text-syn-violet" />
        <div className="text-sm">
          <p className="font-medium">Looking for an app&apos;s database or domain?</p>
          <p className="mt-1 text-muted-foreground">Open its project: databases, domains, jobs and deployments for each product live there. This area is for administrators managing the server itself.</p>
          <Link href="/projects" className="mt-2 inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline">Go to projects<ArrowRight className="h-3.5 w-3.5" /></Link>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {infrastructureItems.map(item => (
          <Link key={item.href} href={item.href} className="syn-tile flex items-start gap-4 p-5">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-black"><item.icon className="h-5 w-5" /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{item.label}</span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">{item.description}</span>
              {facts[item.href] && <span className="mt-2 block text-xs text-foreground/80">{facts[item.href]}</span>}
            </span>
            <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
          </Link>
        ))}
      </div>
    </AppShell>
  )
}
