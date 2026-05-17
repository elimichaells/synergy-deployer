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
  }
}
