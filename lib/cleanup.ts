import { query } from './db'

export async function cleanupOrphanedDeployments() {
    try {
        const { rows } = await query<{ id: string }>(
            `SELECT id FROM deployments WHERE status = 'running'`
        )

        if (rows.length === 0) return

        const ids = rows.map(r => r.id)
        const logParams = [
            '\n[system] Deployment marked as failed because the server restarted while it was running.',
            ids
        ]

        await query(
            `UPDATE deployments
       SET status = 'failed', finished_at = now(), log = COALESCE(log || $1, $1)
       WHERE id = ANY($2)`,
            logParams
        )

        console.log(`[cleanup] Marked ${rows.length} orphaned deployments as failed`)
    } catch (error) {
        console.error('[cleanup] Failed to cleanup orphaned deployments:', error)
    }
}
