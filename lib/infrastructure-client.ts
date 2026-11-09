// Shared screens await the selected agent's acknowledgement before reporting success.
export type InfrastructureScope = { serverId?: string; onWorkspaceHashChange?: (hash: string) => void }

/** A remote screen must never fall back to a host mutation. */
export async function scopedInfrastructureFetch(serverId: string | undefined, url: string, init?: RequestInit): Promise<Response> {
  if (!serverId || url === '/api/auth/me') return fetch(url, init)
  const routes: [string, string][] = [
    ['/api/server/memory', '/memory'], ['/api/server/databases', '/databases'],
    ['/api/system/release-cleanup', '/disk'], ['/api/automation', '/automation'],
    ['/api/operations', '/operations'], ['/api/sites', '/apps'],
  ]
  const match = routes.find(([prefix]) => url === prefix || url.startsWith(prefix + '/') || url.startsWith(prefix + '?'))
  if (!match) throw Error('This infrastructure request has no remote-server destination')
  const readOperation=url==='/api/server/databases'||/^\/api\/automation\/workers\/[^/]+\/logs$/.test(url)||(!init?.method||init.method==='GET')&&/^\/api\/sites\/[^/]+\/logs(?:\?|$)/.test(url)
  const suffix=match[1]+url.slice(match[0].length)+(url==='/api/server/databases'?'/inspect':'')
  const response = await fetch(`/api/servers/${serverId}/resources${suffix}`, readOperation?{...init,method:'POST'}:init)
  if (!response.ok) return response
  try { return Response.json(await infrastructureResponse(response, `/api/servers/${serverId}/infrastructure`, init?.signal || undefined)) }
  catch (error) { return Response.json({ error: (error as Error).message }, { status: 409 }) }
}

export const infrastructureAppHref = (serverId: string | undefined, appId: string, tab = 'settings') => serverId
  ? `/infrastructure/servers/${serverId}?tab=${tab}#app-${appId}` : `/sites/${appId}?tab=${tab}`

export async function infrastructureResponse(response:Response,endpoint?:string,signal?:AbortSignal) {
  const body=await response.json().catch(()=>({}))
  if(!response.ok)throw Error(body.error||'Infrastructure request failed')
  if(!body.jobId||!endpoint)return body
  const until=Date.now()+90000
  while(Date.now()<until){
    signal?.throwIfAborted()
    await new Promise(resolve=>setTimeout(resolve,1500))
    signal?.throwIfAborted()
    const timeout=AbortSignal.timeout(10000)
    const poll=await fetch(`${endpoint}/jobs/${body.jobId}`,{cache:'no-store',signal:signal?AbortSignal.any([signal,timeout]):timeout}),data=await poll.json()
    if(!poll.ok)throw Error(data.error||'Unable to read operation status')
    if(data.job.status==='success')return {...data.job.result,message:data.job.log||'Operation completed',output:data.job.result?.output||data.job.log}
    if(!['queued','running'].includes(data.job.status))throw Error(data.job.log||`Operation ${data.job.status}`)
  }
  throw Error('The server has not confirmed completion. Refresh its state before retrying.')
}
