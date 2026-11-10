'use client'
import {useStorageTransport} from '@/lib/storage-client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { RenameApp } from '@/lib/database-rename'

/** History stays visible after a reload so shared apps cannot miss the env update. */
export function RenameReminders({ database, refreshKey,isAdmin=false }: { database?: string; refreshKey?: string;isAdmin?:boolean }) {
  const [renames, setRenames] = useState<{ id: string; old_name: string; new_name: string; apps: RenameApp[]; status: string; error: string | null }[]>([])
  const [error, setError] = useState('')
  const {fetch,serverId}=useStorageTransport()
  const [busy,setBusy]=useState<string|null>(null)
  const [refresh,setRefresh]=useState(0)
  useEffect(() => {
    void fetch('/api/storage/renames', { cache: 'no-store' }).then(async response => {
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Could not load rename reminders')
      setRenames(body.renames); setError('')
    }).catch(error => setError((error as Error).message))
  }, [database, refreshKey,fetch,refresh])
  const reconcile=async(id:string)=>{setBusy(id);setError('');try{const response=await fetch(`/api/storage/renames/${id}/reconcile`,{method:'POST'}),body=await response.json();if(!response.ok)throw Error(body.error||'Could not verify the rename');setRefresh(value=>value+1)}catch(error){setError((error as Error).message)}finally{setBusy(null)}}
  const visible = renames.filter(rename => !database || rename.new_name === database || rename.old_name === database)
  if (!visible.length && !error) return null
  return <div className="space-y-3">
    {error && <p role="alert" className="notice-error">{error}</p>}
    {visible.map(rename => <div key={rename.id} className="rounded-lg border border-amber-400/30 bg-amber-400/5 p-4 text-sm">
      <p className="font-medium">{rename.old_name} → {rename.new_name}: {rename.status === 'succeeded' ? 'connection update reminder' : 'rename needs review'}</p>
      <p className="mt-1">{rename.status === 'succeeded' ? 'Update saved .env files, connection URLs and external clients to the new name, then restart or redeploy every app sharing this database. Manager updated its Storage links; saved app files were not changed.' : rename.error || 'A rename started. Verify its outcome before making further database changes.'}</p>
      <div className="mt-2 flex flex-wrap gap-3">{rename.apps.map(app => <Link key={app.projectId} className="underline" href={serverId?`/infrastructure/servers/${serverId}?tab=environment#app-${app.projectId}`:`/sites/${app.projectId}?tab=environment`}>{app.name} · {app.environment}</Link>)}</div>
      {serverId&&isAdmin&&rename.status==='needs_review'&&<button className="mt-3 underline" disabled={!!busy} onClick={()=>void reconcile(rename.id)}>{busy===rename.id?'Verifying…':'Verify rename outcome'}</button>}
    </div>)}
  </div>
}
