'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, KeyRound, Loader2, ScrollText, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FrameworkAvatar } from '@/components/synergy/framework-logo'
import { DeploymentRow, type DeploymentSummary } from '@/components/synergy/deployment-row'
import { Section, roleLabels } from '@/components/app/section'
import { describeEnvName, type EnvFileSummary } from '@/lib/env-describe'
import { toolHref } from '@/components/app/app-tools'

export interface ToolApp { id: string; name: string; component_role: string; environment: string; project_type: string; is_active: boolean; setup_required: boolean; deployment_status: string | null }

function AppHeading({ app }: { app: ToolApp }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <FrameworkAvatar type={app.project_type} size="sm" />
      <div className="min-w-0">
        <Link href={`/sites/${app.id}`} className="truncate text-sm font-medium hover:underline">{app.name}</Link>
        <p className="text-xs text-muted-foreground">{roleLabels[app.component_role] || 'App'}{app.environment === 'staging' ? ' · staging' : ''}</p>
      </div>
    </div>
  )
}

/** Every release of every app in the project, newest first. */
export function ProjectDeployments({ apps, now }: { apps: ToolApp[]; now: number }) {
  const [deployments, setDeployments] = useState<DeploymentSummary[] | null>(null)
  const [error, setError] = useState('')
  const key = apps.map(app => app.id).join(',')
  useEffect(() => {
    let cancelled = false
    void Promise.all(apps.map(async app => {
      const response = await fetch(`/api/deployments?project_id=${app.id}&limit=15`, { cache: 'no-store' })
      if (!response.ok) throw new Error('Could not load the deployments')
      const body = await response.json()
      return (Array.isArray(body) ? body : body.deployments || []) as DeploymentSummary[]
    })).then(lists => {
      if (cancelled) return
      setDeployments(lists.flat().sort((a, b) => Date.parse(b.started_at || '') - Date.parse(a.started_at || '')).slice(0, 40))
    }).catch(err => { if (!cancelled) { setError((err as Error).message); setDeployments([]) } })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return (
    <Section title="Deployments" description="Every release of every app in this project, newest first. A deployment is Synergy building your code and putting it live. Open one to see its build output, which is where you find out why one failed.">
      {error && <p role="alert" className="notice-error">{error}</p>}
      {deployments === null ? <div className="space-y-2">{[0, 1, 2].map(i => <div key={i} className="h-14 animate-pulse rounded-lg border border-border bg-card" />)}</div>
        : deployments.length ? <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">{deployments.map(deployment => <DeploymentRow key={deployment.id} deployment={deployment} now={now} />)}</div>
          : <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">Nothing has been deployed yet. Open the Apps tab and press Deploy on an app.</p>}
    </Section>
  )
}

/** Which env files each app has and the names of the variables in them. Values stay on the server. */
export function ProjectEnvironment({ projectId, apps, canView }: { projectId: string; apps: ToolApp[]; canView: boolean }) {
  const [files, setFiles] = useState<Record<string, EnvFileSummary[]> | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!canView) return
    void fetch(`/api/groups/${projectId}/environment`, { cache: 'no-store' }).then(async response => {
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not read the environment files')
      setFiles(body.apps)
    }).catch(err => { setError((err as Error).message); setFiles({}) })
  }, [canView, projectId])

  return (
    <Section title="Environment variables" description={<>These are the settings and secrets each app reads when it starts: a database address, an API key, a mail password. They live in each app&apos;s <span className="font-mono text-xs">.env</span> file on this server. Only the <em>names</em> are shown here, never the values. Open an app to change them.</>}>
      {!canView ? <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">Only administrators and operators can see environment variables.</p>
        : files === null ? <div className="h-24 animate-pulse rounded-lg border border-border bg-card" />
          : (
            <div className="space-y-3">
              {error && <p role="alert" className="notice-error">{error}</p>}
              {apps.map(app => {
                const appFiles = (files[app.id] || []).filter(file => file.exists)
                return (
                  <div key={app.id} className="rounded-lg border border-border p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <AppHeading app={app} />
                      <Button asChild size="sm" variant="outline"><Link href={toolHref(app.id, 'environment')}><KeyRound className="mr-1.5 h-3.5 w-3.5" />Edit variables<ArrowRight className="ml-1.5 h-3.5 w-3.5" /></Link></Button>
                    </div>
                    {appFiles.length ? appFiles.map(file => (
                      <div key={file.file} className="mt-3">
                        <p className="text-xs text-muted-foreground"><span className="font-mono text-foreground">{file.file}</span> · {file.names.length} variable{file.names.length === 1 ? '' : 's'}</p>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {file.names.slice(0, 40).map(name => <span key={name} title={describeEnvName(name) || undefined} className="rounded-md border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">{name}</span>)}
                          {file.names.length > 40 && <span className="px-1 text-xs text-muted-foreground">and {file.names.length - 40} more</span>}
                        </div>
                      </div>
                    )) : <p className="mt-3 text-xs text-muted-foreground">No <span className="font-mono">.env</span> file yet. Open the app&apos;s Environment tab to create one.</p>}
                  </div>
                )
              })}
            </div>
          )}
    </Section>
  )
}

/** One place to reach each app's logs and its terminal. */
export function ProjectLogsConsole({ apps, canRun }: { apps: ToolApp[]; canRun: boolean }) {
  return (
    <Section title="Logs & console" description="Logs show what an app prints while it runs. When something is not working, look at the logs first. The console is a terminal for one-off commands, such as running database migrations or an npm script.">
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {apps.map(app => (
          <div key={app.id} className="flex flex-wrap items-center gap-3 px-4 py-3.5">
            <div className="min-w-0 flex-1"><AppHeading app={app} /></div>
            <span className="text-xs text-muted-foreground">{app.setup_required ? 'Setup incomplete' : !app.deployment_status ? 'Not deployed yet' : app.is_active ? 'Running' : 'Stopped'}</span>
            <Button asChild size="sm" variant="outline"><Link href={toolHref(app.id, 'logs')}><ScrollText className="mr-1.5 h-3.5 w-3.5" />Open logs</Link></Button>
            {canRun && <Button asChild size="sm" variant="outline"><Link href={toolHref(app.id, 'console')}><Terminal className="mr-1.5 h-3.5 w-3.5" />Open console</Link></Button>}
          </div>
        ))}
        {!apps.length && <p className="px-4 py-8 text-center text-sm text-muted-foreground">This project has no apps yet.</p>}
      </div>
      {!apps.some(app => app.deployment_status) && <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3 w-3" />Logs appear once an app has been deployed and is running.</p>}
    </Section>
  )
}
