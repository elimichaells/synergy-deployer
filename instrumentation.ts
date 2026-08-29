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

    // Per-database backup schedules, with the legacy nightly setting as fallback.
    try {
      const { backupSchedulerTick } = await import('@/lib/backups')
      const { recoverInterruptedBackupSchedules } = await import('@/lib/backup-schedules')
      await recoverInterruptedBackupSchedules()
      setInterval(() => void backupSchedulerTick(), 60_000)
      void backupSchedulerTick()
    } catch (err) {
      console.error('[System] Failed to start backup scheduler:', err)
    }

    try {
      const { query } = await import('@/lib/db')
      await query('alter table projects add column if not exists auto_deploy boolean not null default false')
      await query('alter table projects alter column auto_deploy set default false')
      await query('alter table projects add column if not exists deploy_script text')
    } catch (err) {
      console.error('[System] Failed to ensure project deployment schema:', err)
    }

    try {
      const { migrateLegacyGitHubConnection } = await import('@/lib/github-connections')
      await migrateLegacyGitHubConnection()
    } catch (err) {
      console.error('[System] Failed to initialize GitHub connections:', err)
    }

    try {
      const { ensureProjectDatabaseSchema } = await import('@/lib/project-databases')
      await ensureProjectDatabaseSchema()
    } catch (err) {
      console.error('[System] Failed to initialize project databases:', err)
    }

    try {
      const { updateCaddy } = await import('@/lib/caddy')
      await updateCaddy('deploy.smartcloudgh.com', 4000)
    } catch (err) {
      console.error('[System] Failed to refresh Manager proxy routes:', err)
    }

    try {
      const { cronSchedulerTick, recoverInterruptedCronJobs } = await import('@/lib/cron-jobs')
      await recoverInterruptedCronJobs()
      setInterval(() => void cronSchedulerTick(), 15_000)
      void cronSchedulerTick()
    } catch (err) {
      console.error('[System] Failed to start cron scheduler:', err)
    }
  }
}
