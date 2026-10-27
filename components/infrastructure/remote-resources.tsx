import { Section } from '@/components/app/section'
import { Button } from '@/components/ui/button'
import type { RemoteApp } from '@/lib/managed-server-types'
import { remoteAppHref } from '@/lib/remote-workspace'
import { Database, Globe2 } from 'lucide-react'
import Link from 'next/link'
export function RemoteResources({ apps, mode }: { apps: RemoteApp[]; mode: 'storage' | 'domains' }) {
  const database = mode === 'storage', Icon = database ? Database : Globe2
  return <Section title={database ? 'Application databases' : 'Domains & HTTPS'} description={database ? 'Connections and databases used by applications on this server.' : 'Readable LAN and WAN addresses served by Caddy on this server.'}>
    {!apps.length && <p className="py-6 text-center text-sm text-muted-foreground">Import an application to configure its database and address.</p>}
    <div className="divide-y divide-border">{apps.map(app => <div key={app.id} className="flex flex-wrap items-center gap-3 py-4"><Icon className="h-5 w-5 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="text-sm font-medium">{database ? app.database_config?.database || 'No managed connection' : app.hostname.endsWith('.invalid') ? 'No domain configured' : app.hostname}</p><p className="mt-1 text-xs text-muted-foreground">{app.name} · {app.environment_name || 'production'}{database ? app.database_config ? ` · ${app.database_config.provider} · ${app.database_config.status}` : '' : ` · ${app.access_mode.toUpperCase()} HTTPS`}</p></div><Button variant="outline" size="sm" asChild><Link href={remoteAppHref(app.server_id,app.id,mode)}>Manage</Link></Button></div>)}</div>
  </Section>
}
