export interface ApplicationRemovalReview {
  application: { id: string; name: string; environment: string; serverId: string | null }
  domains: string[]
  related: { id: string; name: string }[]
  queuedJobs: number
  requiresAgent: boolean
  blockers: string[]
  reviewToken: string
}
