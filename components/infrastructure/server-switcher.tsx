'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, Plus, Server } from 'lucide-react'
import { recentServerKey, serverOverview, type ServerScope } from '@/lib/server-navigation'
import { serverStatusColor, serverStatusLabel, useServerDirectory } from './server-directory'

const itemClass = 'flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 text-sm outline-none data-[highlighted]:bg-white/[0.06]'

export function ServerSwitcher({ scope }: { scope: ServerScope }) {
  const { data, error, refresh } = useServerDirectory()
  const selected = scope.kind === 'remote' ? data?.servers.find(server => server.id === scope.id) : null
  const selectedId = scope.kind === 'local' ? 'local' : selected?.id
  useEffect(() => {
    if (!selectedId || !data?.userId || selected?.status === 'revoked') return
    try { localStorage.setItem(recentServerKey(data.userId), selectedId) } catch { /* Storage can be disabled. */ }
  }, [selectedId, data?.userId, selected?.status])

  const title = scope.kind === 'local' ? 'Manager host' : scope.kind === 'remote' ? selected?.name || 'Server workspace' : 'All servers'
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <button type="button" aria-label={`Switch server: ${title}`} className="flex min-w-0 max-w-[220px] items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-sm hover:border-border hover:bg-white/[0.04] data-[state=open]:bg-white/[0.06]">
        {selected ? <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${error ? 'bg-zinc-500' : serverStatusColor[selected.status]}`} /> : <Server aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />}
        <span className="truncate font-medium">{title}</span><ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content align="start" sideOffset={8} className="z-50 w-80 max-w-[calc(100vw-24px)] rounded-lg border border-border bg-popover p-1 shadow-2xl shadow-black/60">
        <DropdownMenu.Label className="px-3 py-2 text-xs text-muted-foreground">Switch server</DropdownMenu.Label>
        <DropdownMenu.Item asChild><Link href="/overview" className={itemClass}><Server className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1"><span className="block">Manager host</span><span className="block truncate text-xs text-muted-foreground">{data?.local?.hostname || 'Local apps and infrastructure'}</span></span>{scope.kind === 'local' && <Check className="h-4 w-4" aria-label="Selected" />}</Link></DropdownMenu.Item>
        <div className="max-h-64 overflow-y-auto">
          {data?.servers.filter(server => server.enabled).map(server => <DropdownMenu.Item key={server.id} asChild><Link href={serverOverview(server.id)} className={itemClass}>
            <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${error ? 'bg-zinc-500' : serverStatusColor[server.status]}`} />
            <span className="min-w-0 flex-1"><span className="block truncate">{server.name}</span><span className="block truncate text-xs text-muted-foreground">{server.platform === 'win32' ? 'Windows' : 'Linux'} · {error ? 'Status unavailable' : serverStatusLabel[server.status]}{server.location && ` · ${server.location}`}</span></span>
            {selectedId === server.id && <Check className="h-4 w-4" aria-label="Selected" />}
          </Link></DropdownMenu.Item>)}
        </div>
        {!data && !error && <p className="px-3 py-2 text-xs text-muted-foreground" role="status">Loading servers…</p>}
        {error && <DropdownMenu.Item onSelect={refresh} className={itemClass}>Could not refresh servers. Retry</DropdownMenu.Item>}
        <DropdownMenu.Separator className="my-1 h-px bg-border" />
        <DropdownMenu.Item asChild><Link href="/" className={itemClass}><Server className="h-4 w-4" />View all servers</Link></DropdownMenu.Item>
        {data?.role === 'admin' && <DropdownMenu.Item asChild><Link href="/infrastructure/servers?add=1" className={itemClass}><Plus className="h-4 w-4" />Add server</Link></DropdownMenu.Item>}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
}
