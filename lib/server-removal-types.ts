export type ServerRemovalReview = {
  server: { id: string; name: string; platform: string; enrolled: boolean; enabled: boolean }
  applications: { id: string; name: string; hostname: string; environment_name: string; deployed_at: string | null }[]
  domains: { id: string; hostname: string }[]
  queuedOperations: number
  history: { jobs: number; agentUpdates: number; serviceOperations: number }
  requiresConfirmation: boolean
  blockers: string[]
  reviewToken: string
}
