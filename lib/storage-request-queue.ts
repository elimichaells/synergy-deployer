/** Agent jobs are serial. Share identical read requests and queue other reads per server. */
const pending=new Map<string,Promise<{status:number;body:unknown}>>()
const servers=new Map<string,Promise<unknown>>()
export function storageRead(serverId:string,key:string,work:()=>Promise<{status:number;body:unknown}>){
  const identity=serverId+'\n'+key,existing=pending.get(identity)
  if(existing)return existing
  const previous=servers.get(serverId)||Promise.resolve()
  const result=previous.catch(()=>{}).then(work)
  pending.set(identity,result);servers.set(serverId,result)
  const release=()=>{if(pending.get(identity)===result)pending.delete(identity);if(servers.get(serverId)===result)servers.delete(serverId)}
  void result.then(release,release)
  return result
}
