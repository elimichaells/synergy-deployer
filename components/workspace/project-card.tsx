import { roleLabels } from '@/components/app/section'
import { roleIcons } from '@/components/app/stack-panel'
import { FrameworkAvatar } from '@/components/synergy/framework-logo'
import { StatusDot, type DeployStatus } from '@/components/synergy/status'
import { isApplicationRoot } from '@/lib/application-environments'
import { relativeTime } from '@/lib/deployment-stages'
import { cn } from '@/lib/utils'
import { Boxes, Database, Globe2 } from 'lucide-react'
import Link from 'next/link'
export interface ProjectCardData { id: string; name: string; domains: string[]; database_count?: number; apps: { id: string; name: string; environment: string; production_id: string | null; project_type: string; component_role: string; setup_required?: boolean; deployed_at?: string | null; deployment_status: DeployStatus | null }[] }
export function ProjectCard({ project, href, now }: { project: ProjectCardData; href: string; now: number }) {
            const applications = project.apps.filter(isApplicationRoot)
            const staging = project.apps.filter(app => app.environment === 'staging').length
            const latest = [...project.apps].filter(app => app.deployed_at).sort((a, b) => Date.parse(b.deployed_at!) - Date.parse(a.deployed_at!))[0]
            const failing = applications.filter(app => app.deployment_status === 'failed').length
            const building = project.apps.some(app => app.deployment_status === 'running' || app.deployment_status === 'queued')
            return (
              <article key={project.id} className={cn('syn-tile group flex flex-col p-5', building && 'border-white/15')}>
                {building && <span className="spectrum-flow absolute inset-x-0 top-0 h-[2px] rounded-t-[10px]" aria-hidden="true" />}
                <Link href={href} className="absolute inset-0 z-0 rounded-[10px]" aria-label={`Open project ${project.name}`} />
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-[15px] font-semibold tracking-tight">{project.name}</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">{applications.length} {applications.length === 1 ? 'app' : 'apps'}{staging ? ` · ${staging} staging` : ''}{latest ? ` · updated ${relativeTime(latest.deployed_at, now)}` : ''}</p>
                  </div>
                  <div className="flex -space-x-2">{applications.slice(0, 4).map(app => <span key={app.id} className="rounded-full ring-2 ring-card"><FrameworkAvatar type={app.project_type} size="sm" /></span>)}</div>
                </div>
                <div className="mt-4 space-y-1.5">
                  {applications.slice(0, 4).map(app => {
                    const Icon = roleIcons[app.component_role] || Boxes
                    return (
                      <div key={app.id} className="flex items-center gap-2 text-[13px]">
                        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{app.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{roleLabels[app.component_role]}</span>
                        <span className="ml-auto flex shrink-0 items-center">{app.setup_required ? <span className="text-[11px] text-amber-200">Setup</span> : app.deployment_status ? <StatusDot status={app.deployment_status} className="scale-75" /> : <span className="text-[11px] text-muted-foreground">New</span>}</span>
                      </div>
                    )
                  })}
                  {applications.length > 4 && <p className="text-xs text-muted-foreground">+{applications.length - 4} more</p>}
                </div>
                <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground" style={{ marginTop: 16 }}>
                  <span className="flex min-w-0 items-center gap-1.5"><Globe2 className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{project.domains[0] || 'No domain'}</span>{project.domains.length > 1 && <span>+{project.domains.length - 1}</span>}</span>
                  <span className="flex items-center gap-1.5"><Database className="h-3.5 w-3.5" />{project.database_count === undefined ? 'App databases' : `${project.database_count || 'No'} ${project.database_count === 1 ? 'database' : 'databases'}`}</span>
                  {failing > 0 && <span className="text-status-failed">{failing} failing</span>}
                </div>
              </article>
            )

}
