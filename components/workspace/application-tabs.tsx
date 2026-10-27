import { TabsList, TabsTrigger } from '@/components/ui/tabs';
export function ApplicationTabs({ showSetupTab, activeTab }: { showSetupTab: boolean; activeTab: string }) {
  return (
    <TabsList className="scrollbar-none h-auto min-h-0 w-full justify-start gap-0 overflow-x-auto border-0 bg-transparent p-0">
      {(showSetupTab ? ['setup'] : []).concat(['overview', 'deployments', 'environment', 'logs', 'storage', 'domains', 'settings']).map(value => (
        <TabsTrigger key={value} value={value === 'logs' && activeTab === 'console' ? 'console' : value} title={{ setup: 'Finish connecting your repository, database and domain', overview: 'Is the app running, and what can I do with it?', deployments: 'Every release and its build output', environment: 'The settings and secrets in the .env file', logs: 'What the app prints, and a terminal for running commands', storage: 'Where the app keeps its data', domains: 'The web addresses that open the app', settings: 'Name, repository, build commands, restart and remove' }[value]} className="group relative min-h-0 rounded-none border-0 px-1 pb-3 pt-1 text-[13px] font-normal text-muted-foreground data-[state=active]:text-foreground">
          <span className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 transition-colors group-hover:bg-white/[0.06]">
            {value === 'setup' && <span className="h-1.5 w-1.5 rounded-full spectrum-bar" />}
            {{ setup: 'Setup', overview: 'Overview', deployments: 'Deployments', storage: 'Databases', domains: 'Domains', environment: 'Environment', logs: 'Logs & console', settings: 'Settings' }[value]}
          </span>
          <span className="absolute inset-x-2 bottom-0 hidden h-[2px] rounded-full bg-foreground group-data-[state=active]:block" aria-hidden="true" />
        </TabsTrigger>
      ))}
    </TabsList>
  )

}
