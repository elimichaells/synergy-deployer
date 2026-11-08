import { TabsList, TabsTrigger } from '@/components/ui/tabs'

export const PROJECT_TABS = ['overview', 'apps', 'deployments', 'environment', 'logs', 'storage', 'domains', 'settings'] as const
export type ProjectTab = typeof PROJECT_TABS[number]
const labels = { overview: 'Overview', apps: 'Apps', deployments: 'Deployments', environment: 'Environment', logs: 'Logs & console', storage: 'Databases', domains: 'Domains', settings: 'Settings' }
const descriptions = { overview: 'How the project fits together', apps: 'Every app, with shortcuts to all of its tools', deployments: 'Every release across the project', environment: 'The .env settings of each app', logs: 'Logs and a terminal for each app', storage: 'The project databases and services', domains: 'The web addresses of the project', settings: 'Project and application settings' }

export function ProjectTabs({ unavailable = {} }: { unavailable?: Partial<Record<ProjectTab, string>> }) {
  return <TabsList className="scrollbar-none h-auto min-h-0 w-full justify-start gap-0 overflow-x-auto border-0 bg-transparent p-0">
    {PROJECT_TABS.map(value => <TabsTrigger key={value} value={value} disabled={!!unavailable[value]} title={unavailable[value] || descriptions[value]} className="group relative min-h-0 rounded-none border-0 px-1 pb-3 pt-1 text-[13px] font-normal text-muted-foreground data-[state=active]:text-foreground"><span className="rounded-md px-2.5 py-1.5 transition-colors group-hover:bg-white/[0.06]">{labels[value]}</span><span className="absolute inset-x-2 bottom-0 hidden h-[2px] rounded-full bg-foreground group-data-[state=active]:block" aria-hidden="true" /></TabsTrigger>)}
  </TabsList>
}
