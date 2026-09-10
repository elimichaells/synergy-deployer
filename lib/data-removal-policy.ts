export const ACTIVE_DATA_MIGRATION_STATUSES = ['queued', 'running', 'validating']
const FINISHED_DATA_MIGRATION_STATUSES = ['succeeded', 'failed', 'cancelled', 'interrupted', 'activated']

export function migrationRemovalReason(status: string, workerActive = false): string | null {
  if (ACTIVE_DATA_MIGRATION_STATUSES.includes(status)) return 'Wait for the migration to finish, or cancel it first.'
  if (workerActive) return 'The migration worker is still stopping or cleaning up. Refresh shortly.'
  if (!FINISHED_DATA_MIGRATION_STATUSES.includes(status)) return 'This migration is not eligible for removal.'
  return null
}

export interface DataServiceRemovalFacts {
  application_primary: boolean
  deployment_active: boolean
  backup_status: string | null
  migration_active: boolean
  migration_count: number
}

export function dataServiceRemovalReason(service: DataServiceRemovalFacts): string | null {
  if (service.application_primary) return 'This is the application database. Select another database in the application before removing it.'
  if (service.deployment_active) return 'Wait for this application\'s deployment to finish.'
  if (service.backup_status === 'running') return 'Wait for the database backup to finish.'
  if (service.migration_active) return 'This resource is used by an active migration. Wait for it to finish or cancel it.'
  if (service.migration_count > 0) return `Remove the ${service.migration_count} linked migration history record${service.migration_count === 1 ? '' : 's'} first.`
  return null
}
