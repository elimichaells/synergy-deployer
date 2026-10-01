// Turns the deploy engine's log markers ("[stage] build", "[timing] build: 12s")
// into the pipeline shown by the Synergy deployment views. Pure: safe in the browser.

export type DeploymentStatus = 'queued' | 'running' | 'success' | 'failed'
export type StageState = 'done' | 'active' | 'failed' | 'pending' | 'skipped'

export const PIPELINE = [
  { key: 'initialize', label: 'Initialize' },
  { key: 'checkout', label: 'Checkout' },
  { key: 'install', label: 'Install' },
  { key: 'build', label: 'Build' },
  { key: 'security', label: 'Security' },
  { key: 'preflight', label: 'Preflight' },
  { key: 'activate', label: 'Activate' },
  { key: 'health', label: 'Health' },
] as const

export type PipelineKey = typeof PIPELINE[number]['key']

const PHASE_TO_STAGE: Record<string, PipelineKey> = {
  prepare: 'initialize',
  checkout: 'checkout',
  dependencies: 'install',
  'pre-deploy': 'install',
  script: 'build',
  build: 'build',
  security: 'security',
  preflight: 'preflight',
  waiting_cron: 'activate',
  activate: 'activate',
  health: 'health',
}

const PHASE_LABELS: Record<string, string> = {
  prepare: 'Initialize release',
  checkout: 'Checkout source',
  dependencies: 'Install dependencies',
  'pre-deploy': 'Pre-deploy command',
  script: 'Deployment script',
  build: 'Build',
  security: 'Security gate',
  preflight: 'Candidate preflight',
  activate: 'Activate release',
  health: 'Health check',
}

export interface LogSection {
  id: string
  phase: string
  stage: PipelineKey | null
  label: string
  lines: string[]
  durationSec: number | null
  state: StageState
  errors: number
  warnings: number
}

export interface PipelineStage {
  key: PipelineKey
  label: string
  state: StageState
  durationSec: number | null
}

export interface DeploymentPipeline {
  sections: LogSection[]
  stages: PipelineStage[]
  /** 0..1 share of the pipeline that has completed. */
  progress: number
  currentLabel: string
  zeroDowntime: boolean
  rolledBack: boolean
  /** The failure happened before activation, so the live release was never touched. */
  preserved: boolean
  cancelled: boolean
  errorMessage: string | null
}

export function stageForPhase(phase: string | null | undefined): PipelineKey | null {
  return phase ? PHASE_TO_STAGE[phase] ?? null : null
}

export function cleanLog(text: string) {
  return text
    .replace(/#<\s*CLIXML[\s\S]*?(?:<\/Objs>|$)/gi, '')
    .replace(/<Objs\s+Version="[^"]+"\s+xmlns="http:\/\/schemas\.microsoft\.com\/powershell\/2004\/04">[\s\S]*?(?:<\/Objs>|$)/gi, '')
}

export type LineTone = 'error' | 'warning' | 'success' | 'info' | 'muted' | 'default'

export function lineTone(line: string): LineTone {
  const lower = line.toLowerCase()
  // Engine status lines describe what Synergy did, not build output; "failed candidate retained" is reassurance.
  if (/^\[(release|preflight|handoff|activation|security|rollback|worker|cache|health)\]/.test(lower) && !/^\[error\]/.test(lower)) {
    return /requires attention|blocked|failed/.test(lower) && !/^\[release\]/.test(lower) ? 'warning' : /\bok\b|passed|verified|active on/.test(lower) ? 'success' : 'info'
  }
  if (/^\[error\]|\b(error|fatal|exception|elifecycle|failed)\b/.test(lower) && !/\b0 (errors?|failed)\b/.test(lower)) return 'error'
  if (/^\[cancelled\]|\bwarn(ing)?\b|deprecat/.test(lower)) return 'warning'
  if (/\[health\] ok|\bpassed\b|\bverified\b|\bsuccess|\bcompleted?\b|\bready\b|\bcompiled\b/.test(lower)) return 'success'
  if (/^\[(release|preflight|handoff|activation|security|rollback|worker|cache)\]/.test(lower)) return 'info'
  if (/\b(debug|trace|verbose)\b/.test(lower)) return 'muted'
  return 'default'
}

export function parseDeploymentLog(log: string | null | undefined, status: DeploymentStatus, phase?: string | null): DeploymentPipeline {
  const sections: LogSection[] = []
  const occurrences: Record<string, number> = {}
  const open = (name: string) => {
    occurrences[name] = (occurrences[name] || 0) + 1
    const repeat = occurrences[name] > 1
    const section: LogSection = {
      id: `${name}-${occurrences[name]}`,
      phase: name,
      stage: stageForPhase(name),
      label: repeat && name === 'security' ? 'Final security audit' : PHASE_LABELS[name] || name.replace(/[-_]/g, ' '),
      lines: [],
      durationSec: null,
      state: 'done',
      errors: 0,
      warnings: 0,
    }
    sections.push(section)
    return section
  }

  let current = open('prepare')
  let errorMessage: string | null = null
  let cancelled = false
  const text = cleanLog(log || '')
  for (const raw of text.split(/\r?\n/)) {
    const stage = /^\[stage\] ([\w-]+)\s*$/.exec(raw)
    if (stage) {
      current = open(stage[1])
      continue
    }
    const timing = /^\[timing\] ([\w-]+): (\d+)s\s*$/.exec(raw)
    if (timing) {
      // The engine writes the timing of the stage that just ended, right before the next marker.
      const ended = [...sections].reverse().find(section => section.phase === timing[1] && section.durationSec === null)
      if (ended) ended.durationSec = Number(timing[2])
      continue
    }
    if (raw.startsWith('[error] ')) errorMessage = raw.slice(8).trim()
    if (raw.startsWith('[cancelled] ')) { cancelled = true; errorMessage = raw.slice(12).trim() }
    current.lines.push(raw)
    const tone = lineTone(raw)
    if (tone === 'error') current.errors++
    else if (tone === 'warning') current.warnings++
  }
  // Drop the trailing blank line every flushed chunk ends with.
  for (const section of sections) {
    while (section.lines.length && !section.lines[section.lines.length - 1].trim()) section.lines.pop()
  }

  const last = sections[sections.length - 1]
  if (status === 'running') last.state = 'active'
  if (status === 'queued') last.state = 'pending'
  if (status === 'failed') {
    const failing = [...sections].reverse().find(section => section.lines.some(line => line.startsWith('[error] ') || line.startsWith('[cancelled] '))) || last
    failing.state = 'failed'
  }

  // A live deployment can be ahead of its flushed log; the phase column is authoritative.
  const livePhase = status === 'running' && phase ? stageForPhase(phase) : null
  const reached = new Map<PipelineKey, { state: StageState; durationSec: number | null }>()
  for (const section of sections) {
    if (!section.stage) continue
    const prior = reached.get(section.stage)
    const durationSec = section.durationSec === null && !prior ? null : (prior?.durationSec || 0) + (section.durationSec || 0)
    reached.set(section.stage, { state: section.state === 'done' && prior && prior.state !== 'done' ? prior.state : section.state, durationSec })
  }
  if (livePhase && !reached.has(livePhase)) {
    for (const [key, value] of reached) if (value.state === 'active') reached.set(key, { ...value, state: 'done' })
    reached.set(livePhase, { state: 'active', durationSec: null })
  }

  const order = PIPELINE.map(stage => stage.key)
  // The first security pass runs before install, so it does not mark install/build as skipped.
  const furthest = Math.max(-1, ...[...reached.keys()].filter(key => key !== 'security').map(key => order.indexOf(key)))
  const stages: PipelineStage[] = PIPELINE.map((stage, index) => {
    const seen = reached.get(stage.key)
    if (seen) return { ...stage, state: seen.state, durationSec: seen.durationSec }
    if (status === 'queued') return { ...stage, state: 'pending', durationSec: null }
    if (index < furthest || status === 'success') return { ...stage, state: 'skipped', durationSec: null }
    return { ...stage, state: 'pending', durationSec: null }
  })

  const settled = stages.filter(stage => stage.state === 'done' || stage.state === 'skipped').length
  const progress = status === 'success' ? 1 : status === 'queued' ? 0 : settled / stages.length
  const active = stages.find(stage => stage.state === 'active' || stage.state === 'failed')
  const currentLabel = status === 'success' ? 'Ready'
    : status === 'queued' ? 'Queued'
    : status === 'failed' ? `${cancelled ? 'Cancelled' : 'Failed'}${active ? ` at ${active.label.toLowerCase()}` : ''}`
    : phase === 'waiting_cron' ? 'Waiting for cron job'
    : active ? `${active.label}…` : 'Building…'

  return {
    sections: sections.filter(section => section.lines.length || section.state !== 'done' || section.durationSec !== null),
    stages,
    progress,
    currentLabel,
    zeroDowntime: text.includes('[preflight] Candidate boot and HTTP health verified'),
    rolledBack: text.includes('[rollback] Previous release health verified') || text.includes('[rollback] Managed domains returned'),
    preserved: text.includes('[release] Current application was not replaced'),
    cancelled,
    errorMessage,
  }
}

/**
 * Lightweight pipeline for list rows, which only carry the phase column and a
 * truncated log head. Finished deployments show every stage as settled.
 */
export function stagesFromPhase(status: DeploymentStatus, phase?: string | null, logHead?: string | null): PipelineStage[] {
  const order = PIPELINE.map(stage => stage.key)
  if (status === 'success') return PIPELINE.map(stage => ({ ...stage, state: 'done', durationSec: null }))
  const current = stageForPhase(phase)
  if (status === 'queued' || !current) {
    return PIPELINE.map(stage => ({ ...stage, state: status === 'failed' ? 'skipped' : 'pending', durationSec: null }))
  }
  // The pre-install security pass happens before any install or build stage was logged.
  const earlySecurity = current === 'security' && !/\[stage\] (dependencies|script|build|pre-deploy)\b/.test(logHead || '')
  const currentIndex = earlySecurity ? order.indexOf('checkout') + 0.5 : order.indexOf(current)
  return PIPELINE.map((stage, index) => {
    const state: StageState = stage.key === current ? (status === 'failed' ? 'failed' : 'active') : index < currentIndex ? 'done' : 'pending'
    return { ...stage, state, durationSec: null }
  })
}

export function formatSeconds(totalSeconds: number | null | undefined) {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) return '—'
  const seconds = Math.max(0, Math.round(totalSeconds))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function deploymentDuration(startedAt: string | null, finishedAt: string | null, now = Date.now()) {
  if (!startedAt) return null
  const end = finishedAt ? Date.parse(finishedAt) : now
  return Math.max(0, (end - Date.parse(startedAt)) / 1000)
}

export function relativeTime(value: string | null | undefined, now = Date.now()) {
  if (!value) return '—'
  const seconds = Math.round((now - Date.parse(value)) / 1000)
  if (!Number.isFinite(seconds)) return '—'
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
