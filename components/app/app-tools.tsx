import Link from 'next/link'
import type { ComponentType } from 'react'
import { ArrowRight, Database, Globe2, KeyRound, Rocket, ScrollText, Settings, Terminal, Workflow } from 'lucide-react'
import { cn } from '@/lib/utils'

export type AppToolTab = 'deployments' | 'environment' | 'logs' | 'console' | 'storage' | 'domains' | 'settings'

interface AppTool { tab: AppToolTab | 'jobs'; label: string; short: string; icon: ComponentType<{ className?: string }>; help: string }

/** Everything you can do for an app, named the way a beginner would look for it. */
export const APP_TOOLS: AppTool[] = [
  { tab: 'deployments', label: 'Deployments', short: 'Deployments', icon: Rocket, help: 'Every release of this app, with its build output and what went wrong when one fails.' },
  { tab: 'environment', label: 'Environment variables', short: 'Environment', icon: KeyRound, help: 'The settings and secrets your app reads when it starts (its .env file), such as a database address or an API key.' },
  { tab: 'logs', label: 'Logs', short: 'Logs', icon: ScrollText, help: 'What your app prints while it runs. Look here first when something is not working.' },
  { tab: 'console', label: 'Console', short: 'Console', icon: Terminal, help: "A terminal inside the app's folder, for one-off commands such as database migrations or npm scripts." },
  { tab: 'storage', label: 'Databases', short: 'Databases', icon: Database, help: 'Where your app keeps its data, with backups and connection details.' },
  { tab: 'domains', label: 'Domains', short: 'Domains', icon: Globe2, help: 'The web addresses that open this app.' },
  { tab: 'settings', label: 'Settings', short: 'Settings', icon: Settings, help: 'Name, repository, build and start commands, restarting, and removing the app.' },
  { tab: 'jobs', label: 'Jobs & workers', short: 'Jobs', icon: Workflow, help: 'Tasks that run on a schedule, and background workers that run all the time.' },
]

export const toolHref = (appId: string, tab: AppTool['tab']) => tab === 'jobs' ? `/automation?project=${appId}` : `/sites/${appId}?tab=${tab}`

/** A compact row of labelled links to every tool for one app. */
export function AppToolLinks({ appId, className }: { appId: string; className?: string }) {
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {APP_TOOLS.map(tool => (
        <Link key={tool.tab} href={toolHref(appId, tool.tab)} title={tool.help} className="relative z-10 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-white/25 hover:text-foreground">
          <tool.icon className="h-3.5 w-3.5" aria-hidden="true" />{tool.short}
        </Link>
      ))}
    </div>
  )
}

/** Tiles that each explain a tool in a sentence. On the app's own page they switch tabs instead of navigating. */
export function AppToolGrid({ appId, onSelect, facts }: { appId: string; onSelect?: (tab: AppToolTab) => void; facts?: Partial<Record<AppTool['tab'], string>> }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {APP_TOOLS.map(tool => {
        const inner = (
          <>
            <span className="flex items-center gap-2.5 text-sm font-medium"><tool.icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />{tool.label}<ArrowRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" /></span>
            <span className="mt-1.5 block text-xs leading-5 text-muted-foreground">{tool.help}</span>
            {facts?.[tool.tab] && <span className="mt-2 block text-xs text-foreground/80">{facts[tool.tab]}</span>}
          </>
        )
        const className = 'syn-tile flex flex-col p-4 text-left'
        return onSelect && tool.tab !== 'jobs'
          ? <button key={tool.tab} type="button" onClick={() => onSelect(tool.tab as AppToolTab)} className={className}>{inner}</button>
          : <Link key={tool.tab} href={toolHref(appId, tool.tab)} className={className}>{inner}</Link>
      })}
    </div>
  )
}
