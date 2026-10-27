'use client'
import { PipelineRail } from '@/components/synergy/pipeline'
import { Button } from '@/components/ui/button'
import { ApplicationRelease } from '@/components/workspace/application-release'
import { BuildLogs } from '@/components/workspace/build-logs'
import type { RemoteApp, RemoteJob } from '@/lib/managed-server-types'
import { remoteAppHref, remoteDeployment, remotePipeline } from '@/lib/remote-workspace'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
export function RemoteDeployment({ job, apps, now, canCancel, busy, onCancel }: { job: RemoteJob; apps: RemoteApp[]; now: number; canCancel: boolean; busy: boolean; onCancel: () => void }) {
  const router = useRouter()
  const app = apps.find(item => item.id === job.app_id)!
  const deployment = remoteDeployment(job, apps), stages = remotePipeline(job)
  const live = job.status === 'running' || job.status === 'queued'
  return <div className="space-y-6">
    <div className="flex flex-wrap justify-between gap-3"><Button variant="outline" size="sm" asChild><Link href={remoteAppHref(app.server_id,app.id)}>Application</Link></Button>{job.status === 'queued' && canCancel && <Button variant="outline" size="sm" disabled={busy} onClick={onCancel}>Cancel queued deployment</Button>}</div>
    <ApplicationRelease releaseLabel="Deployment" project={{project_type:app.project_type || 'node',default_branch:deployment.branch || 'Not recorded',repo_url:app.repo_url}} live={deployment} primaryUrl={app.hostname.endsWith('.invalid') ? null : `https://${app.hostname}`} address={app.hostname.endsWith('.invalid') ? null : app.hostname} clock={now} hasRunningDeploy={live} runtimeLogs={false} changeTab={() => { router.push(remoteAppHref(app.server_id,app.id,'deployments')) }}
      statusLabel={job.status === 'success' ? 'Ready' : job.status === 'failed' ? 'Deployment failed' : job.status === 'cancelled' ? 'Cancelled' : job.status === 'queued' ? 'Queued' : stages.find(stage => stage.state === 'active')?.label || 'Initializing…'}
      statusHint={job.status === 'queued' ? 'Waiting for this server’s agent to claim the job.' : job.status === 'success' ? 'Release completed and passed its deployment health check.' : job.status === 'failed' ? 'Review the build output and recovery result below.' : job.status === 'cancelled' ? 'Job cancelled. Review its output for any work already performed.' : 'The agent is deploying this application on the selected server.'} />
    <section className="rounded-xl border border-border bg-card"><div className="border-b border-border px-5 py-3.5"><h2 className="text-sm font-semibold">Synergy pipeline</h2></div><div className="px-3 py-6 sm:px-5"><PipelineRail stages={stages} /></div></section>
    <BuildLogs key={job.id} deployment={deployment} />
  </div>
}
