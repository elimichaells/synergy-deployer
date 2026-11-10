import {createRelay,LIMIT} from '../scripts/database-browser-relay.cjs'
import {DATABASE_BROWSER_CAPABILITY} from '../scripts/manager-agent.cjs'
import {ApiError} from './api'
import {query} from './db'
import {ensureManagedServers,uuid} from './managed-servers'
import {audit} from './audit'

const shared=globalThis as typeof globalThis & {managerDatabaseBrowser?:ReturnType<typeof createRelay>}
export const databaseBrowser=shared.managerDatabaseBrowser??=createRelay()
export {LIMIT}

export async function openDatabaseBrowser(serverId:string,connectionId:string,origin:string,userId:string){
  await ensureManagedServers();uuid(serverId);uuid(connectionId)
  const server=(await query('select enabled,last_seen_at,metrics from managed_servers where id=$1',[serverId])).rows[0]
  if(!server?.enabled||!server.last_seen_at||Date.now()-new Date(server.last_seen_at).getTime()>90000)throw new ApiError('Connect this server before opening its database browser',409)
  if(!server.metrics?.capabilities?.includes(DATABASE_BROWSER_CAPABILITY))throw new ApiError('Update this server in Agent access & updates before opening phpMyAdmin',409)
  if(!server.metrics?.tools?.phpmyadmin)throw new ApiError('Install phpMyAdmin from this server’s Runtimes & tools page first',409)
  const connection=(await query("select id,provider,host,port,tls_enabled,options from remote_storage_connections where server_id=$1 and id=$2 and provider in ('mysql','mariadb')",[serverId,connectionId])).rows[0]
  if(!connection)throw new ApiError('MySQL or MariaDB connection not found on this server',404)
  await audit(userId,'remote.database-browser.open',connectionId,{serverId})
  return databaseBrowser.open(serverId,{...connection,tls:connection.tls_enabled,caPem:connection.options?.caPem||''},origin,userId)
}
export async function authorizeDatabaseBrowser(token:string){
  const session=databaseBrowser.inspect(token)
  const allowed=(await query(`select 1 from managed_servers s join users u on u.id=$2
    join remote_storage_connections c on c.server_id=s.id and c.id=$3
    where s.id=$1 and s.enabled and u.status='active' and u.role='admin'`,[session.serverId,session.userId,session.connectionId])).rowCount
  if(!allowed){databaseBrowser.close(token);throw new ApiError('Database browser access was revoked',403)}
  return session
}
export async function closeDatabaseBrowser(token:string,serverId:string,userId:string){
  const session=databaseBrowser.inspect(token)
  if(session.serverId!==serverId||session.userId!==userId)throw new ApiError('Database browser session not found',404)
  databaseBrowser.close(token)
}
