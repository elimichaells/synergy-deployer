import { db } from '@/lib/db'

export interface BlockingCronJob {
  id: string
  name: string
  last_started_at: string | null
  timeout_seconds: number
}

export async function beginReleaseActivation(projectId: string, root: string, deploymentId: string) {
  const client = await db.connect()
  try {
    await client.query('begin')
    await client.query("select pg_advisory_xact_lock(hashtext('manager-activation'),hashtext($1))", [projectId])
    const cron = await client.query<BlockingCronJob>("select id,name,last_started_at,timeout_seconds from cron_jobs where (project_id=$1 or lower(working_directory)=lower($2)) and last_status='running' order by last_started_at limit 1", [projectId, root])
    if (cron.rows.length) { await client.query('rollback'); return cron.rows[0] }
    await client.query("update deployments set phase='activate' where id=$1", [deploymentId])
    await client.query('commit')
    return null
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
}
