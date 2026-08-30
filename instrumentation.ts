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
      const { dataServiceBackupSchedulerTick, recoverInterruptedDataServiceBackups } = await import('@/lib/data-service-backups')
      await recoverInterruptedBackupSchedules()
      await recoverInterruptedDataServiceBackups()
      setInterval(() => void backupSchedulerTick(), 60_000)
      setInterval(() => void dataServiceBackupSchedulerTick(), 60_000)
      void backupSchedulerTick()
      void dataServiceBackupSchedulerTick()
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
      const { ensureDataServicesSchema } = await import('@/lib/data-services')
      await ensureDataServicesSchema()
    } catch (err) {
      console.error('[System] Failed to initialize data services:', err)
    }

    try {
      const { recoverInterruptedDataMigrations } = await import('@/lib/data-migrations')
      await recoverInterruptedDataMigrations()
    } catch (err) {
      console.error('[System] Failed to initialize database migrations:', err)
    }

    try {
      const { recoverInterruptedRuntimeJobs } = await import('@/lib/runtimes')
      await recoverInterruptedRuntimeJobs()
    } catch (err) {
      console.error('[System] Failed to initialize runtime jobs:', err)
    }

    try {
      const { ensureCloudflareSchema } = await import('@/lib/cloudflare')
      await ensureCloudflareSchema()
    } catch (err) {
      console.error('[System] Failed to initialize Cloudflare and domain schema:', err)
    }

    try {
      const { updateCaddy } = await import('@/lib/caddy')
      await updateCaddy(process.env.MANAGER_DOMAIN || 'deploy.smartcloudgh.com', Number(process.env.MANAGER_PORT || 4000))
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
