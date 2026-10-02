'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowRight, GitCommitHorizontal, Loader2, Rocket, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'

interface Commit { sha: string; subject: string; author: string; date: string }
interface Plan {
  staging: { id: string; name: string; branch: string; commit: string | null }
  production: { id: string; name: string; branch: string; commit: string | null; autoDeploy: boolean }
  mode: 'merge' | 'commit'
  commits: Commit[]; historyKnown: boolean; databaseFiles: string[]
  blocker: string | null; warnings: string[]
}

const short = (sha: string | null) => sha ? sha.slice(0, 7) : 'none'

/**
 * Shows exactly what a promotion would release, then starts it. The commit shown is sent back with
 * the request, so production can only receive what was reviewed here.
 */
export function PromoteSheet({ stagingId, open, onOpenChange, onStarted }: { stagingId: string; open: boolean; onOpenChange: (open: boolean) => void; onStarted: (deploymentId: string, productionId: string) => void }) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    if (!open) return
    setPlan(null); setError('')
    void fetch(`/api/sites/${stagingId}/promote`, { cache: 'no-store' }).then(async response => {
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Could not work out what would be released')
      setPlan(body.plan)
    }).catch(err => setError((err as Error).message))
  }, [open, stagingId])

  const promote = async () => {
    if (!plan?.staging.commit) return
    setStarting(true); setError('')
    try {
      const response = await fetch(`/api/sites/${stagingId}/promote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commit: plan.staging.commit }) })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Promotion could not start')
      onStarted(body.deploymentId, body.productionId)
    } catch (err) { setError((err as Error).message) } finally { setStarting(false) }
  }

  const count = plan?.commits.length || 0
  return (
    <Sheet open={open} onOpenChange={next => { if (!starting) onOpenChange(next) }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Promote to production</SheetTitle>
          <SheetDescription>Release exactly what staging is running. Review it before it goes live.</SheetDescription>
        </SheetHeader>
        <div className="mt-6 space-y-5">
          {!plan && !error && <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Working out what would be released…</div>}
          {plan && <>
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-4 text-sm">
              <div className="min-w-0"><p className="text-xs text-muted-foreground">Staging runs</p><p className="font-mono">{short(plan.staging.commit)} <span className="font-sans text-xs text-muted-foreground">on {plan.staging.branch}</span></p></div>
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0"><p className="text-xs text-muted-foreground">Production runs</p><p className="font-mono">{short(plan.production.commit)} <span className="font-sans text-xs text-muted-foreground">on {plan.production.branch}</span></p></div>
            </div>

            <p className="text-xs leading-5 text-muted-foreground">
              {plan.mode === 'merge'
                ? <>Synergy merges commit <span className="font-mono text-foreground">{short(plan.staging.commit)}</span> into <span className="font-mono text-foreground">{plan.production.branch}</span>, builds and test-starts it, then switches production over. <span className="font-mono text-foreground">{plan.production.branch}</span> on GitHub is updated only after production is live and healthy.</>
                : <>Staging and production share the <span className="font-mono text-foreground">{plan.production.branch}</span> branch, so production moves to exactly commit <span className="font-mono text-foreground">{short(plan.staging.commit)}</span>. Newer commits that staging has not run are left out.</>}
              {' '}If anything fails, production keeps running its current version.
            </p>

            {plan.warnings.length > 0 && <ul className="space-y-2">
              {plan.warnings.map(warning => <li key={warning} className="flex items-start gap-2 rounded-lg border border-status-building/30 bg-status-building/[0.04] p-3 text-xs leading-5 text-amber-100"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-building" />{warning}</li>)}
            </ul>}

            <div>
              <p className="mb-2 text-sm font-medium">{plan.historyKnown ? `${count} commit${count === 1 ? '' : 's'} going to production` : 'Commits going to production'}</p>
              {count > 0 ? (
                <div className="max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                  {plan.commits.map(commit => (
                    <div key={commit.sha} className="flex items-start gap-3 px-3 py-2.5 text-sm">
                      <GitCommitHorizontal className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <div className="min-w-0 flex-1"><p className="break-words">{commit.subject}</p><p className="mt-0.5 text-xs text-muted-foreground"><span className="font-mono">{short(commit.sha)}</span> · {commit.author} · {commit.date}</p></div>
                    </div>
                  ))}
                </div>
              ) : <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">{plan.historyKnown ? 'No new commits.' : 'The commit list is not available here. Check the branch on GitHub.'}</p>}
              {count >= 50 && <p className="mt-2 text-xs text-muted-foreground">Showing the newest 50.</p>}
            </div>

            {plan.blocker
              ? <p role="alert" className="flex items-start gap-2 rounded-lg border border-red-400/25 bg-red-400/5 p-3 text-sm text-red-300"><XCircle className="mt-0.5 h-4 w-4 shrink-0" />{plan.blocker}</p>
              : <Button className="w-full" onClick={() => void promote()} disabled={starting}>{starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Rocket className="mr-2 h-4 w-4" />}Promote {short(plan.staging.commit)} to {plan.production.name}</Button>}
          </>}
          {error && <p role="alert" className="notice-error">{error}</p>}
        </div>
      </SheetContent>
    </Sheet>
  )
}
