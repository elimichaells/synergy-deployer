// Shared screens await the selected agent's acknowledgement before reporting success.
export async function infrastructureResponse(response:Response,endpoint?:string) {
  const body=await response.json().catch(()=>({}))
  if(!response.ok)throw Error(body.error||'Infrastructure request failed')
  if(!body.jobId||!endpoint)return body
  const until=Date.now()+90000
  while(Date.now()<until){
    await new Promise(resolve=>setTimeout(resolve,1500))
    const poll=await fetch(`${endpoint}/jobs/${body.jobId}`,{cache:'no-store',signal:AbortSignal.timeout(10000)}),data=await poll.json()
    if(!poll.ok)throw Error(data.error||'Unable to read operation status')
    if(data.job.status==='success')return {...data.job.result,message:data.job.log||'Operation completed',output:data.job.result?.output||data.job.log}
    if(!['queued','running'].includes(data.job.status))throw Error(data.job.log||`Operation ${data.job.status}`)
  }
  throw Error('The server has not confirmed completion. Refresh its state before retrying.')
}
