import type { ReactNode } from 'react'
import { ArrowRight, Database, Globe2, KeyRound, Layers, Rocket, ScrollText } from 'lucide-react'
import { Section } from '@/components/app/section'
import type { ProjectTab } from './project-tabs'

/** Project navigation and topology are identical on the manager and agent hosts. */
export function ProjectOverview({ onTab, domains, applications, databases, unavailable = {} }: {
  onTab: (tab: ProjectTab) => void; domains: ReactNode; applications: ReactNode; databases: ReactNode; unavailable?: Partial<Record<ProjectTab, string>>
}) {
  return <div className="space-y-6">
    <Section title="What do you want to do?" description="Pick what you are looking for. Every tab here works for all the apps in this project at once.">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {([
          ['deployments', Rocket, 'See releases', 'Every deployment, and why one failed.'],
          ['environment', KeyRound, 'Edit settings and secrets', 'The .env file each app reads, such as database addresses and API keys.'],
          ['logs', ScrollText, 'Read logs or run a command', 'What each app prints while running, and a terminal inside it.'],
          ['storage', Database, 'Manage databases', 'Where the apps keep their data.'],
          ['domains', Globe2, 'Manage web addresses', 'Which domains open which app.'],
          ['apps', Layers, 'Open or deploy an app', 'Every app with shortcuts to all of its tools.'],
        ] as const).map(([value, Icon, title, description]) => <button key={value} type="button" disabled={!!unavailable[value]} onClick={() => onTab(value)} className="syn-tile flex flex-col p-4 text-left disabled:cursor-not-allowed disabled:opacity-60"><span className="flex items-center gap-2.5 text-sm font-medium"><Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />{title}<ArrowRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" /></span><span className="mt-1.5 text-xs leading-5 text-muted-foreground">{unavailable[value] || description}</span></button>)}
      </div>
    </Section>
    <Section title="How it fits together" description="Requests come in through a domain, reach your apps, and the apps read and write their databases.">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_auto_minmax(0,1.3fr)_auto_minmax(0,0.9fr)] lg:items-start">
        <div className="min-w-0 space-y-2"><p className="eyebrow flex items-center gap-1.5"><Globe2 className="h-3 w-3" />Domains</p>{domains}</div>
        <ArrowRight className="mx-auto hidden h-4 w-4 text-muted-foreground lg:mt-9 lg:block" />
        <div className="min-w-0 space-y-2"><p className="eyebrow flex items-center gap-1.5"><Layers className="h-3 w-3" />Apps</p>{applications}</div>
        <ArrowRight className="mx-auto hidden h-4 w-4 text-muted-foreground lg:mt-9 lg:block" />
        <div className="min-w-0 space-y-2"><p className="eyebrow flex items-center gap-1.5"><Database className="h-3 w-3" />Data</p>{databases}</div>
      </div>
    </Section>
  </div>
}

export function ProjectEnvironmentSwitch({ environments, value, onChange }: { environments: ('production' | 'staging')[]; value: string; onChange: (environment: 'production' | 'staging') => void }) {
  if (!environments.includes('staging')) return null
  return <div className="mb-6 flex h-8 w-fit items-center rounded-md border border-border p-0.5" role="group" aria-label="Environment">{environments.map(environment => <button key={environment} type="button" onClick={() => onChange(environment)} aria-pressed={environment === value} className={`h-full rounded-[5px] px-3 text-xs capitalize ${environment === value ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>{environment}</button>)}</div>
}
