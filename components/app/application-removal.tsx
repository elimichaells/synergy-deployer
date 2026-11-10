'use client'
import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Section } from '@/components/app/section'
import { Button } from '@/components/ui/button'
import { infrastructureResponse } from '@/lib/infrastructure-client'
import type { ApplicationRemovalReview } from '@/lib/application-removal-types'

/** The same reviewed action for host applications and connected servers. */
export function ApplicationRemoval({ appId, name, serverId, onRemoved }: { appId: string; name: string; serverId?: string; onRemoved: () => void }) {
  const [review,setReview]=useState<ApplicationRemovalReview|null>(null),[confirmation,setConfirmation]=useState(''),[acknowledged,setAcknowledged]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null)
  const endpoint=serverId?`/api/servers/${serverId}/apps/${appId}/removal`:`/api/sites/${appId}/removal`
  async function load() {
    setBusy(true);setError(null);setConfirmation('');setAcknowledged(false)
    try{const response=await fetch(endpoint,{cache:'no-store'});const body=await response.json();if(!response.ok)throw Error(body.error||'Unable to review removal');setReview(body)}catch(e){setError((e as Error).message)}finally{setBusy(false)}
  }
  async function remove() {
    if(!review)return
    setBusy(true);setError(null)
    try{
      await infrastructureResponse(await fetch(endpoint,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({reviewToken:review.reviewToken,confirmationName:confirmation,acknowledged})}),serverId?`/api/servers/${serverId}/infrastructure`:undefined)
      onRemoved()
    }catch(e){setError((e as Error).message);setReview(null)}finally{setBusy(false)}
  }
  return <Section tone="danger" title="Remove application" description={<>Remove {name} from Manager. Its running process, files, databases, DNS and proxy routes stay on the server. Manager will no longer deploy, monitor or manage this application.</>}>
    {error&&<p role="alert" className="mb-3 text-sm text-red-300">{error}</p>}
    {!review?<Button variant="destructive" size="sm" disabled={busy} onClick={()=>void load()}>{busy?'Checking…':'Review removal'}</Button>:<div className="space-y-4">
      <div className="space-y-2 text-sm text-muted-foreground"><p>Application: <strong className="text-foreground">{review.application.name}</strong> · {review.application.environment}</p>
        <p>Deployment history and saved configuration will leave the workspace. {review.queuedJobs>0&&`${review.queuedJobs} queued operation(s) will be cancelled.`}</p>
        {!!review.domains.length&&<p>Preserved addresses: {review.domains.join(', ')}</p>}
        {!!review.related.length&&<p>Related applications stay on this server and become independent: {review.related.map(app=>app.name).join(', ')}.</p>}
        {review.requiresAgent&&<p>Manager waits for this server’s agent to confirm preservation before removing the application.</p>}
      </div>
      {!!review.blockers.length&&<ul className="list-disc space-y-1 pl-5 text-sm text-amber-300">{review.blockers.map(message=><li key={message}>{message}</li>)}</ul>}
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={acknowledged} disabled={busy} onChange={e=>setAcknowledged(e.target.checked)}/>I understand that Manager will stop managing this application and its saved history will no longer be available in the workspace.</label>
      <label className="field-label">Type {review.application.name} to confirm<input className="control-input max-w-md" value={confirmation} disabled={busy} onChange={e=>setConfirmation(e.target.value)} autoComplete="off" aria-label="Confirm application name"/></label>
      <div className="flex gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={()=>setReview(null)}>Cancel</Button><Button variant="destructive" size="sm" disabled={busy||!!review.blockers.length||!acknowledged||confirmation!==review.application.name} onClick={()=>void remove()}><Trash2 className="mr-1.5 h-3.5 w-3.5"/>{busy?'Removing…':'Remove from Manager'}</Button><Button variant="ghost" size="sm" disabled={busy} onClick={()=>void load()}>Refresh review</Button></div>
    </div>}
  </Section>
}
