export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { seedSettingsFromEnv } = await import('@/lib/settings')
    await seedSettingsFromEnv()

    // Cleanup orphaned deployments
    try {
      const { cleanupOrphanedDeployments } = await import('@/lib/cleanup')
      await cleanupOrphanedDeployments()
    } catch (err) {
      console.error('[System] Failed to cleanup orphaned deployments:', err)
    }

    // Nightly Postgres backup scheduler (runs when BACKUP_ENABLED=true)
    try {
      const { backupSchedulerTick } = await import('@/lib/backups')
      setInterval(() => void backupSchedulerTick(), 10 * 60_000)
      void backupSchedulerTick()
    } catch (err) {
      console.error('[System] Failed to start backup scheduler:', err)
    }
  }
}
