import { roleLabels } from '@/components/app/section'
import type { DeploymentSummary } from '@/components/synergy/deployment-row'
import { FrameworkAvatar } from '@/components/synergy/framework-logo'
import { PipelineMini } from '@/components/synergy/pipeline'
import { stagesFromPhase } from '@/lib/deployment-stages'
import { cn } from '@/lib/utils'
import { Layers, Pin, Zap } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
const repoLabel = (repo: string | null) => repo ? repo.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '') : null
const liveUrl = (url: string | null) => url ? (url.startsWith('http') ? url : `https://${url}`) : null
export function ApplicationCard({ project, latest, href, actions, deploymentLine, statusLabel }: {
  project: { id: string; name: string; project_type: string; repo_url: string | null; url: string | null; port: number | null; pm2_name?: string; environment: string; pinned?: boolean; auto_deploy?: boolean; application_group_name?: string | null; component_role?: string; is_active: boolean }
  latest?: DeploymentSummary; href: string; actions?: ReactNode; deploymentLine: ReactNode; statusLabel?: string
}) {
  const live = latest && (latest.status === 'running' || latest.status === 'queued')
    return (
      <article key={project.id} className={cn('syn-tile group flex min-h-[176px] flex-col p-5', live && 'border-white/15')}>
        {live && <span className="spectrum-flow absolute inset-x-0 top-0 h-[2px] rounded-t-[10px]" aria-hidden="true" />}
        <Link href={href} className="absolute inset-0 z-0 rounded-[10px]" aria-label={`Open ${project.name}`} />
        <div className="flex items-start gap-3">
          <FrameworkAvatar type={project.project_type} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-[15px] font-semibold tracking-tight">{project.name}</h3>
              {project.pinned && <Pin className="h-3 w-3 shrink-0 fill-current text-muted-foreground" aria-label="Pinned" />}
            </div>
            {liveUrl(project.url)
              ? <a href={liveUrl(project.url)!} target="_blank" rel="noreferrer" className="relative z-10 block truncate text-[13px] text-muted-foreground hover:text-foreground hover:underline">{project.url!.replace(/^https?:\/\//, '')}</a>
              : <p className="truncate text-[13px] text-muted-foreground">{project.port ? `localhost:${project.port}` : project.pm2_name}</p>}
          </div>
          {actions}
        </div>

        {repoLabel(project.repo_url) && (
          <p className="mt-4 flex w-fit max-w-full items-center gap-1.5 rounded-full border border-border bg-white/[0.03] px-2.5 py-1 text-xs font-medium">
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
            <span className="truncate">{repoLabel(project.repo_url)}</span>
          </p>
        )}

        <div className="mt-auto pt-4">
          {live && latest && <PipelineMini stages={latest.stages || stagesFromPhase(latest.status, latest.phase, latest.log)} className="mb-2.5" />}
          <div className="text-xs text-muted-foreground">{deploymentLine}</div>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className={cn('rounded-full border px-2 py-px text-[11px] font-medium', project.environment === 'production' ? 'border-sky-400/25 text-sky-300' : 'border-amber-300/25 text-amber-200')}>{project.environment === 'production' ? 'Production' : 'Staging'}</span>
            {project.auto_deploy && <span className="flex items-center gap-1 rounded-full border border-border px-2 py-px text-[11px] text-muted-foreground"><Zap className="h-3 w-3" />Auto-deploy</span>}
            {project.application_group_name && <span className="flex min-w-0 items-center gap-1 truncate rounded-full border border-syn-violet/30 bg-syn-violet/10 px-2 py-px text-[11px] text-violet-200"><Layers className="h-3 w-3 shrink-0" />{roleLabels[project.component_role || 'application']} · {project.application_group_name}</span>}
            <span className={cn('ml-auto flex items-center gap-1.5 text-[11px]', project.is_active ? 'text-muted-foreground' : 'text-muted-foreground/60')}>
              <span className={cn('h-1.5 w-1.5 rounded-full', project.is_active ? 'bg-status-ready' : 'bg-white/25')} />{statusLabel || (project.is_active ? 'Online' : 'Offline')}
            </span>
          </div>
        </div>
      </article>
    )
}
