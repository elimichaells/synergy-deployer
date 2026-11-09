'use client'
import { PipelineRail } from '@/components/synergy/pipeline'
import { Button } from '@/components/ui/button'
import { ApplicationRelease } from '@/components/workspace/application-release'
import { BuildLogs } from '@/components/workspace/build-logs'
import { SecurityGateBlocked,SecurityGateOverridden } from '@/components/app/security-gate'
import type { RemoteApp, RemoteJob } from '@/lib/managed-server-types'
import { remoteAppHref, remoteDeployment, remotePipeline } from '@/lib/remote-workspace'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
export function RemoteDeployment({ job, apps, now, canCancel, canRollback, busy, onCancel, onRollback,role }: { job: RemoteJob; apps: RemoteApp[]; now: number; canCancel: boolean; canRollback?:boolean; busy: boolean; onCancel: () => void; onRollback?:()=>void;role?:'admin'|'operator'|'viewer' }) {
  const router = useRouter()
  const app = apps.find(item => item.id === job.app_id)!
  const deployment = remoteDeployment(job, apps), stages = remotePipeline(job)
  const live = job.status === 'running' || job.status === 'queued'
  return <div className="space-y-6">
    {job.security_status==='failed'&&job.status==='failed'&&<SecurityGateBlocked deploymentId={job.id} appName={app.name} branch={job.branch||app.branch} log={job.log} role={role} serverId={app.server_id} onStarted={id=>router.push(`/infrastructure/servers/${app.server_id}?view=${id}#deployments`)}/>}
    {job.security_status==='overridden'&&<SecurityGateOverridden log={job.log} branch={job.branch||app.branch}/>}
    <div className="flex flex-wrap justify-between gap-3"><Button variant="outline" size="sm" asChild><Link href={remoteAppHref(app.server_id,app.id)}>Application</Link></Button>{live && canCancel && <Button variant="outline" size="sm" disabled={busy||job.cancel_requested} onClick={()=>{if(window.confirm('Cancel this deployment? If activation has started, Manager restores the previous release before confirming cancellation.'))onCancel()}}>{job.cancel_requested?'Cancellation requested…':'Cancel deployment'}</Button>}</div>
    {job.status==='success'&&job.commit_sha&&canRollback&&<div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border p-4"><p className="text-sm text-muted-foreground">Rebuild this commit with the application’s current environment and settings. Database contents are preserved.</p><Button variant="outline" disabled={busy} onClick={()=>{if(window.confirm(`Roll back ${app.name} to commit ${job.commit_sha!.slice(0,8)}? This creates a new deployment using current settings. It does not roll back database contents.`))onRollback?.()}}>Roll back to this release</Button></div>}
    <ApplicationRelease releaseLabel="Deployment" project={{project_type:app.project_type || 'node',default_branch:deployment.branch || 'Not recorded',repo_url:app.repo_url}} live={deployment} primaryUrl={app.hostname.endsWith('.invalid') ? null : `https://${app.hostname}`} address={app.hostname.endsWith('.invalid') ? null : app.hostname} clock={now} hasRunningDeploy={live} runtimeLogs={false} changeTab={() => { router.push(remoteAppHref(app.server_id,app.id,'deployments')) }}
      statusLabel={job.status === 'success' ? 'Ready' : job.status === 'failed' ? 'Deployment failed' : job.status === 'cancelled' ? 'Cancelled' : job.status === 'queued' ? 'Queued' : stages.find(stage => stage.state === 'active')?.label || 'Initializing…'}
      statusHint={job.status === 'queued' ? 'Waiting for this server’s agent to claim the job.' : job.status === 'success' ? 'Release completed and passed its deployment health check.' : job.status === 'failed' ? 'Review the build output and recovery result below.' : job.status === 'cancelled' ? 'Job cancelled. Review its output for any work already performed.' : 'The agent is deploying this application on the selected server.'} />
    <section className="rounded-xl border border-border bg-card"><div className="border-b border-border px-5 py-3.5"><h2 className="text-sm font-semibold">Synergy pipeline</h2></div><div className="px-3 py-6 sm:px-5"><PipelineRail stages={stages} /></div></section>
    <BuildLogs key={job.id} deployment={deployment} />
  </div>
}
