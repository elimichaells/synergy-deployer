'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import {
  ArrowDownToLine, Ban, ChevronDown, Copy, ExternalLink, GitBranch, GitCommitHorizontal, Globe,
  RefreshCw, RotateCcw, Search, ShieldAlert, ShieldCheck, Zap, Check, X, Minus,
} from 'lucide-react'
import { AppShell } from '@/components/layout/app-shell'
import { Button } from '@/components/ui/button'
import { PipelineRail } from '@/components/synergy/pipeline'
import { EnvironmentBadge, StatusLabel, type DeployStatus } from '@/components/synergy/status'
import { FrameworkAvatar } from '@/components/synergy/framework-logo'
import { SynergyMark } from '@/components/synergy/brand'
import { watchDeployment } from '@/lib/deployment-watch'
import { deploymentDuration, formatSeconds, lineTone, parseDeploymentLog, relativeTime, type LineTone, type LogSection } from '@/lib/deployment-stages'
import { cn } from '@/lib/utils'

interface Deployment {
  id: string
  project_id: string
  project_name: string
  status: DeployStatus
  branch: string | null
  commit_sha: string | null
  started_at: string | null
  finished_at: string | null
  trigger?: string | null
  phase?: string | null
  security_status?: string | null
  is_active?: boolean
  user_name?: string | null
  log?: string | null
}

interface Project {
  id: string
  name: string
  repo_url: string | null
  project_type: string
  environment: 'production' | 'staging'
  port: number | null
  url: string | null
}

interface SessionUser { name: string; role: 'admin' | 'operator' | 'viewer' }

const toneClass: Record<LineTone, string> = {
  error: 'text-[#ff8a8a]',
  warning: 'text-[#f5c26b]',
  success: 'text-[#5fe0a6]',
  info: 'text-[#8fb8ff]',
  muted: 'text-white/35',
  default: 'text-[#d6d6d6]',
}

function commitUrl(repo: string | null | undefined, sha: string | null) {
  if (!repo || !sha) return null
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repo)
  return match ? `https://github.com/${match[1]}/${match[2]}/commit/${sha}` : null
}

function SectionIcon({ state }: { state: LogSection['state'] }) {
  if (state === 'failed') return <span className="flex h-4 w-4 items-center justify-center rounded-full bg-status-failed text-white"><X className="h-2.5 w-2.5" strokeWidth={3.5} /></span>
  if (state === 'active') return <RefreshCw className="h-4 w-4 animate-spin text-syn-cyan" />
  if (state === 'pending' || state === 'skipped') return <span className="flex h-4 w-4 items-center justify-center rounded-full border border-white/20 text-muted-foreground"><Minus className="h-2.5 w-2.5" /></span>
  return <span className="flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-background"><Check className="h-2.5 w-2.5" strokeWidth={3.5} /></span>
}

export default function DeploymentPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [deployment, setDeployment] = useState<Deployment | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [domains, setDomains] = useState<string[]>([])
  const [user, setUser] = useState<SessionUser | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [busy, setBusy] = useState<'redeploy' | 'rollback' | 'cancel' | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [filter, setFilter] = useState('')
  const [follow, setFollow] = useState(true)
  const [copied, setCopied] = useState(false)

  const canWrite = user?.role === 'admin' || user?.role === 'operator'

  useEffect(() => {
    void fetch('/api/auth/me').then(response => response.ok ? response.json() : { user: null }).then(data => setUser(data.user)).catch(() => {})
  }, [])

  // Live deployments stream until they settle; finished ones resolve in one request.
  useEffect(() => {
    if (!id) return
    setDeployment(null)
    setNotFound(false)
    const watcher = watchDeployment<Deployment>(id, data => { setDeployment(data); setError(null) }, () => {
      void fetch(`/api/deployments/${encodeURIComponent(id)}`, { cache: 'no-store' }).then(response => {
        if (response.status === 404) { setNotFound(true); watcher.close() }
      }).catch(() => setError('Connection lost — retrying…'))
    })
    return () => watcher.close()
  }, [id])

  const projectId = deployment?.project_id
  useEffect(() => {
    if (!projectId) return
    void fetch(`/api/sites/${projectId}`).then(response => response.ok ? response.json() : null).then(setProject).catch(() => {})
    void fetch(`/api/domains?project=${projectId}`).then(response => response.ok ? response.json() : null)
      .then(data => setDomains((data?.domains || []).map((domain: { hostname: string }) => domain.hostname))).catch(() => {})
  }, [projectId])

  const live = deployment?.status === 'running' || deployment?.status === 'queued'
  useEffect(() => {
    if (!live) return
    const clock = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(clock)
  }, [live])

  const pipeline = useMemo(() => deployment ? parseDeploymentLog(deployment.log, deployment.status, deployment.phase) : null, [deployment])

  // Keep the stage that is running or failed open, like a build log that follows itself.
  useEffect(() => {
    if (!pipeline) return
    const focus = pipeline.sections.find(section => section.state === 'active' || section.state === 'failed')
    if (focus) setOpen(current => current[focus.id] === undefined ? { ...current, [focus.id]: true } : current)
  }, [pipeline])

  const query = filter.trim().toLowerCase()
  const visibleSections = useMemo(() => {
    if (!pipeline) return []
    let offset = 0
    return pipeline.sections.map(section => {
      const lines = section.lines.map((text, index) => ({ text, number: offset + index + 1, tone: lineTone(text) }))
      offset += section.lines.length
      return { section, lines: query ? lines.filter(line => line.text.toLowerCase().includes(query)) : lines }
    })
  }, [pipeline, query])

  const totals = useMemo(() => (pipeline?.sections || []).reduce((sum, section) => ({ errors: sum.errors + section.errors, warnings: sum.warnings + section.warnings, lines: sum.lines + section.lines.length }), { errors: 0, warnings: 0, lines: 0 }), [pipeline])

  const act = useCallback(async (kind: 'redeploy' | 'rollback' | 'cancel') => {
    if (!deployment) return
    if (kind === 'rollback' && !window.confirm(`Roll back ${deployment.project_name} to ${deployment.commit_sha?.slice(0, 7)}? Synergy rebuilds that exact commit and swaps it in once it passes preflight.`)) return
    if (kind === 'cancel' && !window.confirm('Cancel this deployment? The current live release stays online.')) return
    setBusy(kind)
    setError(null)
    try {
      const endpoint = kind === 'redeploy' ? `/api/sites/${deployment.project_id}/deploy` : `/api/deployments/${deployment.id}/${kind}`
      const response = await fetch(endpoint, { method: 'POST' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || `Could not ${kind}`)
      if (body.deploymentId) router.push(`/deployments/${body.deploymentId}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not ${kind}`)
    } finally {
      setBusy(null)
    }
  }, [deployment, router])

  const copyLogs = async () => {
    if (!deployment?.log) return
    await navigator.clipboard.writeText(deployment.log).catch(() => {})
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const downloadLogs = () => {
    if (!deployment?.log) return
    const url = URL.createObjectURL(new Blob([deployment.log], { type: 'text/plain' }))
    const anchor = Object.assign(document.createElement('a'), { href: url, download: `${deployment.project_name}-${deployment.id.slice(0, 8)}.log` })
    anchor.click()
    URL.revokeObjectURL(url)
  }

  if (notFound) {
    return (
      <AppShell title="Deployment not found" back={{ href: '/deployments', label: 'Deployments' }} user={user || undefined}>
        <div className="rounded-xl border border-dashed border-border py-20 text-center text-sm text-muted-foreground">This deployment no longer exists or the link is incorrect.</div>
      </AppShell>
    )
  }

  if (!deployment || !pipeline) {
    return (
      <AppShell title="Loading deployment…" back={{ href: '/deployments', label: 'Deployments' }} user={user || undefined}>
        <div className="space-y-4">
          <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />
          <div className="h-28 animate-pulse rounded-xl border border-border bg-card" />
          <div className="h-80 animate-pulse rounded-xl border border-border bg-card" />
        </div>
      </AppShell>
    )
  }

  const duration = deploymentDuration(deployment.started_at, deployment.finished_at, now)
  const visitUrl = project?.url ? (project.url.startsWith('http') ? project.url : `https://${project.url}`) : domains[0] ? `https://${domains[0]}` : null
  const commitLink = commitUrl(project?.repo_url, deployment.commit_sha)
  const repoName = project?.repo_url?.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '')

  return (
    <AppShell
      title={deployment.project_name}
      back={{ href: '/deployments', label: 'Deployments' }}
      user={user || undefined}
      subtitle={<span className="flex items-center gap-2"><span className="font-mono text-[13px]">{deployment.id.slice(0, 8)}</span><EnvironmentBadge environment={project?.environment} current={deployment.is_active} /></span>}
      actions={<>
        {visitUrl && <Button asChild variant="outline" size="sm"><a href={visitUrl} target="_blank" rel="noreferrer">Visit<ExternalLink className="ml-1.5 h-3.5 w-3.5" /></a></Button>}
        <Button asChild variant="outline" size="sm"><Link href={`/sites/${deployment.project_id}`}>Application</Link></Button>
        {deployment.status === 'running' && <Button variant="outline" size="sm" disabled={!canWrite || busy !== null} onClick={() => void act('cancel')} className="text-red-300 hover:text-red-200"><Ban className="mr-1.5 h-3.5 w-3.5" />{busy === 'cancel' ? 'Cancelling…' : 'Cancel'}</Button>}
        {deployment.status === 'success' && !deployment.is_active && deployment.commit_sha && <Button variant="outline" size="sm" disabled={!canWrite || busy !== null} onClick={() => void act('rollback')}><RotateCcw className="mr-1.5 h-3.5 w-3.5" />{busy === 'rollback' ? 'Starting…' : 'Roll back to this'}</Button>}
        {!live && <Button size="sm" disabled={!canWrite || busy !== null} onClick={() => void act('redeploy')}><RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', busy === 'redeploy' && 'animate-spin')} />Redeploy</Button>}
      </>}
    >
      {error && <div role="alert" className="notice-error">{error}</div>}

      {/* Release capsule + facts */}
      <section className="grid overflow-hidden rounded-xl border border-border bg-card lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        <div className="relative flex min-h-[260px] flex-col justify-between overflow-hidden border-b border-border bg-black p-6 lg:border-b-0 lg:border-r">
          <div className="syn-canvas pointer-events-none absolute inset-0 opacity-70" aria-hidden="true" />
          {live && <div className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-syn-violet/20 blur-3xl" aria-hidden="true" />}
          {live && <div className="pointer-events-none absolute -bottom-24 -right-16 h-72 w-72 rounded-full bg-syn-cyan/15 blur-3xl" aria-hidden="true" />}
          <div className="relative flex items-center gap-3">
            <FrameworkAvatar type={project?.project_type} size="lg" />
            <div className="min-w-0">
              <p className="truncate text-lg font-semibold tracking-tight">{deployment.project_name}</p>
              <p className="truncate font-mono text-xs text-muted-foreground">{repoName || 'local source'}</p>
            </div>
          </div>
          <div className="relative mt-8">
            <p className={cn('text-2xl font-semibold tracking-[-0.03em] sm:text-3xl', live && 'spectrum-text')}>{pipeline.currentLabel}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {deployment.status === 'success' ? (deployment.is_active ? `Serving${project?.port ? ` on port ${project.port}` : ''} · verified healthy` : 'Built and verified · superseded by a newer release')
                : deployment.status === 'failed' ? (pipeline.rolledBack ? 'Previous release restored and verified healthy' : pipeline.preserved || pipeline.cancelled ? 'Your live release was never touched' : 'See the highlighted stage below')
                : deployment.status === 'queued' ? 'Waiting for a deployment slot' : `${formatSeconds(duration)} elapsed · the live release stays online until the candidate passes preflight`}
            </p>
            <div className="mt-5 h-1 overflow-hidden rounded-full bg-white/[0.06]">
              <div className={cn('h-full rounded-full transition-[width] duration-700', live ? 'spectrum-flow' : deployment.status === 'failed' ? 'bg-status-failed' : 'bg-status-ready')} style={{ width: `${Math.max(live ? 6 : 100, Math.round(pipeline.progress * 100))}%` }} />
            </div>
          </div>
        </div>

        <dl className="grid content-start gap-x-6 gap-y-5 p-6 text-sm sm:grid-cols-2">
          <div>
            <dt className="eyebrow">Status</dt>
            <dd className="flex flex-wrap items-center gap-2"><StatusLabel status={deployment.status} />{deployment.is_active && <span className="rounded-full border border-white/15 bg-white/[0.06] px-2 py-px text-[11px] font-medium">Current</span>}</dd>
          </div>
          <div>
            <dt className="eyebrow">Created</dt>
            <dd>{relativeTime(deployment.started_at, now)}{deployment.user_name && <span className="text-muted-foreground"> by {deployment.user_name}</span>}</dd>
          </div>
          <div>
            <dt className="eyebrow">Duration</dt>
            <dd className="font-mono">{formatSeconds(duration)}{live && <span className="ml-2 text-xs text-muted-foreground">running</span>}</dd>
          </div>
          <div>
            <dt className="eyebrow">Trigger</dt>
            <dd className="capitalize">{deployment.trigger === 'webhook' || deployment.trigger === 'github' ? 'Git push' : deployment.trigger || 'Manual'}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="eyebrow">Source</dt>
            <dd className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="flex items-center gap-1.5"><GitBranch className="h-4 w-4 text-muted-foreground" />{deployment.branch || '—'}</span>
              {commitLink
                ? <a href={commitLink} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 font-mono hover:underline"><GitCommitHorizontal className="h-4 w-4 text-muted-foreground" />{deployment.commit_sha?.slice(0, 7)}</a>
                : <span className="flex items-center gap-1.5 font-mono"><GitCommitHorizontal className="h-4 w-4 text-muted-foreground" />{deployment.commit_sha?.slice(0, 7) || 'resolving'}</span>}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="eyebrow">Domains</dt>
            <dd className="space-y-1">
              {domains.length ? domains.map(domain => <a key={domain} href={`https://${domain}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 truncate hover:underline"><Globe className="h-3.5 w-3.5 text-muted-foreground" />{domain}</a>)
                : <span className="text-muted-foreground">{project?.port ? `localhost:${project.port}` : 'No domain assigned'}</span>}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="eyebrow">Release guarantees</dt>
            <dd className="flex flex-wrap gap-2">
              <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs', deployment.security_status === 'passed' ? 'border-status-ready/30 text-status-ready' : deployment.security_status === 'failed' ? 'border-status-failed/40 text-status-failed' : 'border-border text-muted-foreground')}>
                {deployment.security_status === 'failed' ? <ShieldAlert className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                {deployment.security_status === 'passed' ? 'Dependency audit passed' : deployment.security_status === 'failed' ? 'Blocked by security gate' : deployment.security_status === 'not_applicable' ? 'Audit not applicable' : 'Security gate pending'}
              </span>
              <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs', pipeline.zeroDowntime ? 'border-syn-cyan/30 text-syn-cyan' : 'border-border text-muted-foreground')}>
                <Zap className="h-3.5 w-3.5" />{pipeline.zeroDowntime ? 'Zero-downtime preflight verified' : project?.port ? 'Preflight pending' : 'No preflight (no port)'}
              </span>
              {pipeline.rolledBack && <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/30 px-2.5 py-1 text-xs text-amber-200"><RotateCcw className="h-3.5 w-3.5" />Auto-rollback succeeded</span>}
            </dd>
          </div>
        </dl>
      </section>

      {/* Pipeline */}
      <section className="mt-6 rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3.5">
          <div className="flex items-center gap-2">
            <SynergyMark className="h-4 w-4" />
            <h2 className="text-sm font-semibold">Synergy pipeline</h2>
          </div>
          <span className="text-xs text-muted-foreground">Candidate is built and verified in isolation, then atomically activated</span>
        </div>
        <div className="px-3 py-6 sm:px-5">
          <PipelineRail stages={pipeline.stages} />
        </div>
        {deployment.status === 'failed' && pipeline.errorMessage && (
          <div className="mx-5 mb-5 flex gap-3 rounded-lg border border-status-failed/30 bg-status-failed/[0.06] px-4 py-3 text-sm">
            <X className="mt-0.5 h-4 w-4 shrink-0 text-status-failed" />
            <div className="min-w-0">
              <p className="font-medium text-red-200">{pipeline.cancelled ? 'Cancelled' : 'Deployment failed'}</p>
              <p className="mt-0.5 break-words font-mono text-xs text-red-200/80">{pipeline.errorMessage}</p>
            </div>
          </div>
        )}
      </section>

      {/* Build logs grouped by stage */}
      <section className="mt-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Deployment details</h2>
            <p className="text-xs text-muted-foreground">{totals.lines} log lines{totals.errors ? ` · ${totals.errors} errors` : ''}{totals.warnings ? ` · ${totals.warnings} warnings` : ''}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <input value={filter} onChange={event => setFilter(event.target.value)} placeholder="Find in logs" aria-label="Find in logs" className="control-input h-8 w-48 pl-8 text-[13px]" />
            </div>
            {live && <Button variant="outline" size="sm" onClick={() => setFollow(value => !value)} aria-pressed={follow}>{follow ? 'Following' : 'Follow'}</Button>}
            <Button variant="outline" size="sm" onClick={() => setOpen(Object.fromEntries(pipeline.sections.map(section => [section.id, !pipeline.sections.every(item => open[item.id])])))}>
              {pipeline.sections.every(section => open[section.id]) ? 'Collapse all' : 'Expand all'}
            </Button>
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => void copyLogs()} title="Copy logs" aria-label="Copy logs">{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}</Button>
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={downloadLogs} title="Download logs" aria-label="Download logs"><ArrowDownToLine className="h-3.5 w-3.5" /></Button>
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {visibleSections.length === 0 && <p className="px-5 py-10 text-center text-sm text-muted-foreground">Waiting for the first log lines…</p>}
          {visibleSections.map(({ section, lines }) => {
            const expanded = query ? lines.length > 0 : !!open[section.id]
            return (
              <div key={section.id} className="border-b border-border last:border-b-0">
                <button type="button" onClick={() => setOpen(current => ({ ...current, [section.id]: !expanded }))} aria-expanded={expanded}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.025]">
                  <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', !expanded && '-rotate-90')} />
                  <SectionIcon state={section.state} />
                  <span className={cn('flex-1 truncate text-sm font-medium', section.state === 'failed' && 'text-red-200')}>{section.label}</span>
                  {section.errors > 0 && <span className="rounded-full bg-status-failed/15 px-2 py-px text-[11px] font-medium text-red-300">{section.errors} err</span>}
                  {section.warnings > 0 && <span className="rounded-full bg-status-building/15 px-2 py-px text-[11px] font-medium text-amber-200">{section.warnings} warn</span>}
                  <span className="w-16 text-right font-mono text-xs text-muted-foreground">{section.state === 'active' ? 'running' : formatSeconds(section.durationSec)}</span>
                </button>
                {expanded && (
                  <div ref={section.state === 'active' && follow ? element => { if (element) element.scrollTop = element.scrollHeight } : undefined}
                    className="max-h-[480px] overflow-auto border-t border-border bg-black py-2 font-mono text-[12px] leading-[20px]">
                    {lines.length === 0 && section.state !== 'active' && <p className="px-4 text-white/35">No output</p>}
                    {lines.map(line => (
                      <div key={line.number} className={cn('flex hover:bg-white/[0.04]', line.tone === 'error' && 'bg-status-failed/[0.08]')}>
                        <span className="sticky left-0 w-14 shrink-0 select-none bg-black pr-4 text-right text-white/25">{line.number}</span>
                        <span className={cn('whitespace-pre-wrap break-all pr-4', toneClass[line.tone])}>{line.text || ' '}</span>
                      </div>
                    ))}
                    {section.state === 'active' && <div className="flex items-center gap-2 px-4 pt-1 text-syn-cyan"><span className="h-3 w-1.5 animate-pulse bg-syn-cyan" /></div>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>
    </AppShell>
  )
}
