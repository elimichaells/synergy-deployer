'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, Copy, ExternalLink, Loader2, ShieldAlert, ShieldCheck, ShieldOff, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { GATE_SCOPES, MIN_REASON_LENGTH, MAX_REASON_LENGTH, cleanReason, findingsSummary, fixCommands, overrideReason, parseSecurityFindings, scopeLabels, type GateScope, type SecurityFinding } from '@/lib/security-gate-policy'
import { cn } from '@/lib/utils'

export interface GateState { off: boolean; indefinite: boolean; until: string | null; reason: string | null; by: string | null; at: string | null }
type Role = 'admin' | 'operator' | 'viewer'

const day = (iso: string | null) => iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''
const gateOffLabel = (gate: GateState) => gate.indefinite ? 'until someone turns it back on' : `until ${day(gate.until)}`

/** Loads an app's gate state once, for the banner and the Settings section to share. */
export function useSecurityGate(projectId: string | undefined) {
  const [gate, setGate] = useState<GateState | null>(null)
  const [canTurnOff, setCanTurnOff] = useState(false)
  const reload = useCallback(() => {
    if (!projectId) return
    void fetch(`/api/sites/${projectId}/security-gate`, { cache: 'no-store' }).then(response => response.ok ? response.json() : null)
      .then(body => { if (body) { setGate(body.gate); setCanTurnOff(!!body.canTurnOff) } }).catch(() => {})
  }, [projectId])
  useEffect(reload, [reload])
  return { gate, canTurnOff, reload, setGate }
}

/** Turning the gate back on is always allowed for anyone who can deploy. */
function useTurnGateOn(projectId: string, onChanged: (gate: GateState) => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const turnOn = async () => {
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/sites/${projectId}/security-gate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enforce: true }) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not turn the gate back on')
      onChanged(body.gate)
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return { busy, error, turnOn }
}

function SeverityBadge({ severity }: { severity: SecurityFinding['severity'] }) {
  return <span className={cn('shrink-0 rounded-full px-2 py-px text-[11px] font-medium uppercase tracking-wide', severity === 'critical' ? 'bg-status-failed/20 text-red-200' : 'bg-status-building/15 text-amber-200')}>{severity}</span>
}

/** The vulnerable packages the gate found, in plain terms. */
export function SecurityFindings({ findings, compact }: { findings: SecurityFinding[]; compact?: boolean }) {
  if (!findings.length) return <p className="rounded-lg border border-dashed border-border px-4 py-4 text-xs text-muted-foreground">The details are in the Security gate stage of the log below.</p>
  return (
    <ul className={cn('divide-y divide-border overflow-y-auto rounded-lg border border-border', compact ? 'max-h-56' : 'max-h-80')}>
      {findings.map(finding => (
        <li key={`${finding.severity}:${finding.package}`} className="px-3 py-2.5 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={finding.severity} />
            <span className="font-mono font-medium">{finding.package}</span>
            <span className="text-xs text-muted-foreground">affected versions: <span className="font-mono">{finding.affected}</span></span>
          </div>
          {!compact && finding.advisories.length > 0 && <ul className="mt-1.5 space-y-0.5">
            {finding.advisories.map(advisory => <li key={advisory.title + advisory.url} className="text-xs leading-5 text-muted-foreground">
              {advisory.url
                ? <a href={advisory.url} target="_blank" rel="noreferrer" className="inline-flex items-start gap-1 hover:text-foreground hover:underline">{advisory.title}<ExternalLink className="mt-1 h-3 w-3 shrink-0" /></a>
                : advisory.title}
            </li>)}
          </ul>}
          {compact && finding.advisories[0] && <p className="mt-1 truncate text-xs text-muted-foreground">{finding.advisories[0].title}{finding.advisories.length > 1 ? ` (+${finding.advisories.length - 1} more)` : ''}</p>}
          {!compact && finding.fix && <p className="mt-1.5 text-xs text-foreground/80">{finding.fix}.</p>}
        </li>
      ))}
    </ul>
  )
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="flex items-center gap-2 rounded-md border border-border bg-black px-2.5 py-1.5">
      <code className="min-w-0 flex-1 break-all font-mono text-xs">{command}</code>
      <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" aria-label={`Copy ${command}`}
        onClick={() => { void navigator.clipboard.writeText(command).catch(() => {}); setCopied(true); window.setTimeout(() => setCopied(false), 1500) }}>
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </span>
  )
}

const RISKS = [
  'These weaknesses are public. Attackers run automated scans for sites using the affected versions, usually within days of an advisory.',
  'A critical finding can let a stranger run their own commands on this server or read data without signing in. A high finding can leak data, bypass a login or take the app offline.',
  'This server also runs your other apps and databases. A break-in through one app can reach the rest.',
]

interface OverridePlan { projectName: string; branch: string; kind: 'deploy' | 'promote'; staging: { name: string; branch: string; commit: string } | null; blocker: string | null }

/**
 * The deliberate step for going past the gate: what is going online, what that risks, how long the
 * gate stays off, a written reason and an explicit acknowledgement.
 */
export function SecurityOverrideSheet({ open, onOpenChange, target, appName, findings, onDone }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** A stopped deployment to release, or an app whose gate is being switched off. */
  target: { deploymentId: string } | { projectId: string }
  appName: string
  findings: SecurityFinding[]
  onDone: (result: { deploymentId?: string; gate?: GateState }) => void
}) {
  const deploymentId = 'deploymentId' in target ? target.deploymentId : null
  const projectId = 'projectId' in target ? target.projectId : null
  const scopes = useMemo(() => GATE_SCOPES.filter(scope => deploymentId || scope !== 'once'), [deploymentId])
  const [scope, setScope] = useState<GateScope>(scopes[0])
  const [reason, setReason] = useState('')
  const [understood, setUnderstood] = useState(false)
  const [plan, setPlan] = useState<OverridePlan | null>(null)
  const [error, setError] = useState('')
  const [working, setWorking] = useState(false)

  useEffect(() => {
    if (!open) return
    setScope(scopes[0]); setReason(''); setUnderstood(false); setError(''); setPlan(null)
    if (!deploymentId) return
    void fetch(`/api/deployments/${deploymentId}/deploy-anyway`, { cache: 'no-store' }).then(async response => {
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not work out what would be released')
      setPlan(body.plan)
    }).catch(err => setError((err as Error).message))
  }, [open, deploymentId, scopes])

  const reasonLength = cleanReason(reason).length
  const ready = reasonLength >= MIN_REASON_LENGTH && understood && (!deploymentId || (plan && !plan.blocker))

  const submit = async () => {
    setWorking(true); setError('')
    try {
      const response = await fetch(deploymentId ? `/api/deployments/${deploymentId}/deploy-anyway` : `/api/sites/${projectId}/security-gate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, reason, understood, commit: plan?.staging?.commit }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'That did not work')
      onDone(body)
    } catch (err) { setError((err as Error).message) } finally { setWorking(false) }
  }

  return (
    <Sheet open={open} onOpenChange={next => { if (!working) onOpenChange(next) }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{deploymentId ? 'Deploy with known vulnerabilities' : 'Turn off the security gate'}</SheetTitle>
          <SheetDescription>
            {deploymentId
              ? `This puts ${appName} online even though the security gate found problems in the packages it depends on.`
              : `Deployments of ${appName} will go live even when the packages it depends on have known security problems.`}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-5">
          {deploymentId && <div>
            <p className="mb-2 text-sm font-medium">What goes online: {findingsSummary(findings)}</p>
            <SecurityFindings findings={findings} compact />
            {plan && !plan.blocker && <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {plan.kind === 'promote' && plan.staging
                ? <>This re-runs the promotion: commit <span className="font-mono text-foreground">{plan.staging.commit.slice(0, 7)}</span> from {plan.staging.name} goes to <span className="font-mono text-foreground">{plan.branch}</span>.</>
                : <>This deploys the newest commit on <span className="font-mono text-foreground">{plan.branch}</span>. If the build or the test start fails, the live app stays as it is.</>}
            </p>}
          </div>}

          <div className="rounded-lg border border-status-failed/30 bg-status-failed/[0.05] p-4">
            <p className="flex items-center gap-2 text-sm font-medium text-red-200"><AlertTriangle className="h-4 w-4" />What you are accepting</p>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-xs leading-5 text-red-100/85">
              {RISKS.map(risk => <li key={risk}>{risk}</li>)}
            </ul>
          </div>

          <div className="rounded-lg border border-border p-4 text-xs leading-5 text-muted-foreground">
            <p className="text-sm font-medium text-foreground">What does not change</p>
            <ul className="mt-2 list-disc space-y-1.5 pl-5">
              <li>Every deployment is still checked, and what was found is written into its log.</li>
              <li>Releases that go out this way are marked <span className="text-amber-200">Released with known vulnerabilities</span>.</li>
              <li>Your name and reason are recorded in the audit log.</li>
              <li>This does not fix anything. The fix is still to update the packages and push.</li>
            </ul>
          </div>

          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">How long is the gate off?</legend>
            {scopes.map(option => (
              <label key={option} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-sm', scope === option ? 'border-white/30 bg-white/[0.04]' : 'border-border')}>
                <input type="radio" name="gate-scope" className="mt-1" checked={scope === option} onChange={() => setScope(option)} />
                <span>
                  <span className="block">{scopeLabels[option]}</span>
                  <span className="block text-xs text-muted-foreground">
                    {option === 'once' ? 'The next deployment is checked and blocked as usual. Safest choice.'
                      : option === 'always' ? 'Every deployment, including automatic ones, goes live regardless. Easy to forget; pick a date instead if you can.'
                      : 'Every deployment in that time, including automatic ones, goes live regardless. The gate comes back on by itself.'}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          <label className="field-label">
            Why is this acceptable?
            <textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={MAX_REASON_LENGTH} rows={3}
              placeholder="For example: launch is today; the Next.js upgrade is booked for Monday."
              className="control-input h-auto py-2 font-normal" />
            <span className="text-xs font-normal text-muted-foreground">{reasonLength < MIN_REASON_LENGTH ? `At least ${MIN_REASON_LENGTH} characters. ` : ''}Recorded with your name and shown to everyone on the team.</span>
          </label>

          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-3 text-sm">
            <input type="checkbox" className="mt-1" checked={understood} onChange={event => setUnderstood(event.target.checked)} />
            <span>I understand this puts software with known security holes online, and I accept that risk for {appName}.</span>
          </label>

          {plan?.blocker && <p role="alert" className="notice-error">{plan.blocker}</p>}
          {error && <p role="alert" className="notice-error">{error}</p>}

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={working}>Cancel, I will fix it</Button>
            <Button onClick={() => void submit()} disabled={!ready || working} className="bg-status-failed text-white hover:bg-status-failed/90">
              {working ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldOff className="mr-2 h-4 w-4" />}
              {deploymentId ? 'Deploy anyway' : 'Turn the gate off'}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** Shown on a deployment the gate stopped: fix it, or (administrators) knowingly release it. */
export function SecurityGateBlocked({ deploymentId, appName, branch, log, role, autoDeploy, onStarted }: {
  deploymentId: string; appName: string; branch: string; log: string; role: Role | undefined; autoDeploy?: boolean; onStarted: (deploymentId: string) => void
}) {
  const findings = useMemo(() => parseSecurityFindings(log), [log])
  const commands = useMemo(() => fixCommands(findings), [findings])
  const [open, setOpen] = useState(false)
  const [plan, setPlan] = useState<OverridePlan | null>(null)

  useEffect(() => {
    void fetch(`/api/deployments/${deploymentId}/deploy-anyway`, { cache: 'no-store' }).then(response => response.ok ? response.json() : null)
      .then(body => setPlan(body?.plan || null)).catch(() => {})
  }, [deploymentId])

  return (
    <section className="mt-6 overflow-hidden rounded-xl border border-status-failed/30 bg-card">
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-status-failed" />
        <div>
          <h2 className="text-sm font-semibold">Stopped by the security gate</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            This release includes {findingsSummary(findings)} in the packages the app depends on, so it was not put online. Your live app is unchanged and still running.
          </p>
        </div>
      </div>

      <div className="space-y-5 p-5">
        <SecurityFindings findings={findings} />

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-status-ready/30 bg-status-ready/[0.04] p-4">
            <p className="flex items-center gap-2 text-sm font-medium"><Wrench className="h-4 w-4 text-status-ready" />Fix it <span className="rounded-full bg-status-ready/15 px-2 py-px text-[11px] font-medium text-status-ready">Recommended</span></p>
            <ol className="mt-3 list-decimal space-y-2.5 pl-5 text-xs leading-5 text-muted-foreground">
              <li>Open the app&apos;s code on your computer, in a terminal in its folder.</li>
              <li>
                Update the affected packages:
                <span className="mt-1.5 grid gap-1.5">
                  {(commands.length ? commands : [{ command: 'npm audit fix', note: 'Applies the updates npm can make safely.' }]).map(item => <span key={item.command} className="grid gap-1"><CopyCommand command={item.command} /><span>{item.note}</span></span>)}
                </span>
              </li>
              <li>Start the app and check it still works.</li>
              <li>Commit <span className="font-mono text-foreground">package.json</span> and <span className="font-mono text-foreground">package-lock.json</span>, then push to <span className="font-mono text-foreground">{branch}</span>.</li>
              <li>{autoDeploy ? 'The push deploys by itself.' : 'Come back here and press Redeploy.'} The gate checks again and lets it through once the packages are fixed.</li>
            </ol>
          </div>

          <div className="flex flex-col rounded-lg border border-border p-4">
            <p className="flex items-center gap-2 text-sm font-medium"><ShieldOff className="h-4 w-4 text-status-building" />Deploy anyway</p>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              Put this release online with the vulnerable packages still in it. Use this when going live cannot wait and you have a plan to fix it soon.
              You choose whether it applies to this deployment only or to this app for a while, and your reason is recorded.
            </p>
            <div className="mt-auto pt-4">
              {plan?.blocker
                ? <p className="text-xs text-muted-foreground">{plan.blocker}</p>
                : role === 'admin'
                  ? <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="border-status-failed/40 text-red-200 hover:text-red-100">Review the risk and deploy anyway</Button>
                  : <p className="text-xs text-muted-foreground">Only an administrator can deploy past the security gate. Ask one to open this page.</p>}
            </div>
          </div>
        </div>
      </div>

      <SecurityOverrideSheet open={open} onOpenChange={setOpen} target={{ deploymentId }} appName={appName} findings={findings}
        onDone={result => { setOpen(false); if (result.deploymentId) onStarted(result.deploymentId) }} />
    </section>
  )
}

/** Shown on a release that went live past the gate. */
export function SecurityGateOverridden({ log, branch }: { log: string; branch: string }) {
  const findings = useMemo(() => parseSecurityFindings(log), [log])
  const why = useMemo(() => overrideReason(log), [log])
  const commands = useMemo(() => fixCommands(findings), [findings])
  return (
    <section className="mt-6 overflow-hidden rounded-xl border border-status-building/30 bg-card">
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-status-building" />
        <div>
          <h2 className="text-sm font-semibold">Released with known vulnerabilities</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            The security gate found {findingsSummary(findings)} and an administrator chose to release anyway{why ? `, for ${why.scope === 'app' ? 'this app' : 'this deployment only'}` : ''}.
            {why?.reason ? <> Reason given: <span className="text-foreground">{why.reason}</span></> : null}
          </p>
        </div>
      </div>
      <div className="space-y-3 p-5">
        <SecurityFindings findings={findings} />
        <p className="text-xs leading-5 text-muted-foreground">
          To remove the exposure, update the packages in the app&apos;s code{commands.length ? <> (<span className="font-mono text-foreground">{commands.map(item => item.command).join(', ')}</span>)</> : ''}, commit the lockfile and push to <span className="font-mono text-foreground">{branch}</span>.
        </p>
      </div>
    </section>
  )
}

/** A standing reminder on the app page while its gate is off. */
export function SecurityGateBanner({ projectId, gate, canWrite, onChanged }: { projectId: string; gate: GateState | null; canWrite: boolean; onChanged: (gate: GateState) => void }) {
  const { busy, error, turnOn } = useTurnGateOn(projectId, onChanged)
  if (!gate?.off) return null
  return (
    <div role="status" className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-status-building/40 bg-status-building/[0.06] px-4 py-3 text-sm">
      <ShieldOff className="h-4 w-4 shrink-0 text-status-building" />
      <p className="min-w-0 flex-1 text-amber-100">
        <span className="font-medium">The security gate is off for this app {gateOffLabel(gate)}.</span>{' '}
        <span className="text-amber-100/75">Deployments go live even with known vulnerabilities.{gate.by ? ` Turned off by ${gate.by}${gate.at ? ` on ${day(gate.at)}` : ''}.` : ''}{gate.reason ? ` Reason: ${gate.reason}` : ''}</span>
      </p>
      {canWrite && <Button variant="outline" size="sm" onClick={() => void turnOn()} disabled={busy}>{busy ? 'Turning on…' : 'Turn the gate back on'}</Button>}
      {error && <p role="alert" className="w-full text-xs text-red-300">{error}</p>}
    </div>
  )
}

/** The Settings control for an app's gate. */
export function SecurityGateSetting({ projectId, appName, gate, canTurnOff, canWrite, onChanged }: {
  projectId: string; appName: string; gate: GateState | null; canTurnOff: boolean; canWrite: boolean; onChanged: (gate: GateState) => void
}) {
  const [open, setOpen] = useState(false)
  const { busy, error, turnOn } = useTurnGateOn(projectId, onChanged)

  return (
    <div className="space-y-3">
      <div className={cn('flex flex-wrap items-center justify-between gap-4 rounded-lg border px-4 py-3 text-sm', gate?.off ? 'border-status-building/40 bg-status-building/[0.05]' : 'border-border')}>
        <span className="flex min-w-0 items-start gap-3">
          {gate?.off ? <ShieldOff className="mt-0.5 h-4 w-4 shrink-0 text-status-building" /> : <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-status-ready" />}
          <span>
            <span className="block font-medium">{!gate ? 'Checking…' : gate.off ? `Off ${gateOffLabel(gate)}` : 'On: releases with serious known vulnerabilities are stopped'}</span>
            <span className="block text-xs text-muted-foreground">
              {gate?.off
                ? `${gate.by ? `Turned off by ${gate.by}${gate.at ? ` on ${day(gate.at)}` : ''}. ` : ''}${gate.reason ? `Reason: ${gate.reason}` : ''}`
                : 'Before a release goes live, its packages are checked against public security advisories. High and critical findings stop the release; your live app keeps running.'}
            </span>
          </span>
        </span>
        {gate?.off
          ? <Button size="sm" onClick={() => void turnOn()} disabled={busy || !canWrite}>{busy ? 'Turning on…' : 'Turn back on'}</Button>
          : <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={!gate || !canTurnOff} title={canTurnOff ? undefined : 'Only an administrator can turn the security gate off'}>Turn off…</Button>}
      </div>
      {!gate?.off && <p className="text-xs leading-5 text-muted-foreground">
        If a deployment is stopped, its page shows what was found, how to fix it, and an option for administrators to release that one deployment anyway. You rarely need to turn the gate off here.
      </p>}
      {error && <p role="alert" className="notice-error">{error}</p>}
      <SecurityOverrideSheet open={open} onOpenChange={setOpen} target={{ projectId }} appName={appName} findings={[]}
        onDone={result => { setOpen(false); if (result.gate) onChanged(result.gate) }} />
    </div>
  )
}
