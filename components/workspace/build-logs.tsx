'use client'
import type { DeploymentSummary } from '@/components/synergy/deployment-row'
import { Button } from '@/components/ui/button'
import { formatSeconds, lineTone, parseDeploymentLog, type LineTone, type LogSection } from '@/lib/deployment-stages'
import { cn } from '@/lib/utils'
import { ArrowDownToLine, Check, ChevronDown, Copy, Minus, RefreshCw, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
const toneClass: Record<LineTone, string> = {
  error: 'text-red-300',
  warning: 'text-amber-300',
  success: 'text-emerald-300',
  info: 'text-blue-300',
  muted: 'text-muted-foreground',
  default: 'text-foreground/85',
}

function SectionIcon({ state }: { state: LogSection['state'] }) {
  if (state === 'failed') return <span className="flex h-4 w-4 items-center justify-center rounded-full bg-status-failed text-[#fff]"><X className="h-2.5 w-2.5" strokeWidth={3.5} /></span>
  if (state === 'active') return <RefreshCw className="h-4 w-4 animate-spin text-syn-cyan" />
  if (state === 'pending' || state === 'skipped') return <span className="flex h-4 w-4 items-center justify-center rounded-full border border-white/20 text-muted-foreground"><Minus className="h-2.5 w-2.5" /></span>
  return <span className="flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-background"><Check className="h-2.5 w-2.5" strokeWidth={3.5} /></span>
}

export function BuildLogs({ deployment }: { deployment: DeploymentSummary }) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [filter, setFilter] = useState(''), [follow, setFollow] = useState(true), [copied, setCopied] = useState(false)
  const live = deployment.status === 'running' || deployment.status === 'queued'
  const pipeline = useMemo(() => parseDeploymentLog(deployment.log, deployment.status, deployment.phase), [deployment.log, deployment.status, deployment.phase])
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

  return <>
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
                    className="max-h-[480px] overflow-auto border-t border-border bg-well py-2 font-mono text-[12px] leading-[20px]">
                    {lines.length === 0 && section.state !== 'active' && <p className="px-4 text-white/35">No output</p>}
                    {lines.map(line => (
                      <div key={line.number} className={cn('flex hover:bg-white/[0.04]', line.tone === 'error' && 'bg-status-failed/[0.08]')}>
                        <span className="sticky left-0 w-14 shrink-0 select-none bg-well pr-4 text-right text-white/25">{line.number}</span>
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
  </>
}
