export const SETUP_STEPS = ['repository', 'runtime', 'database', 'environment', 'domain', 'review'] as const
export type SetupStep = typeof SETUP_STEPS[number]
export interface SetupDecisions { database?: 'attached' | 'none'; environment?: 'file' | 'runtime'; domain?: 'configured' | 'later' }
export interface SetupCheck { id: string; step: SetupStep; label: string; status: 'pass' | 'warning' | 'fail'; detail: string }

export function validateSetupProgress(value: unknown): { step: SetupStep; decisions: SetupDecisions } {
  const input = value as { step?: unknown; decisions?: unknown } | null
  if (!input || !SETUP_STEPS.includes(input.step as SetupStep)) throw new Error('Invalid setup step')
  const source = input.decisions as Record<string, unknown> | undefined
  if (source !== undefined && (!source || typeof source !== 'object' || Array.isArray(source))) throw new Error('Invalid setup decisions')
  const decisions: SetupDecisions = {}
  for (const [key, allowed] of Object.entries({ database: ['attached', 'none'], environment: ['file', 'runtime'], domain: ['configured', 'later'] })) {
    if (source?.[key] !== undefined) {
      if (!allowed.includes(String(source[key]))) throw new Error(`Invalid ${key} selection`)
      Object.assign(decisions, { [key]: source[key] })
    }
  }
  return { step: input.step as SetupStep, decisions }
}

export function setupReady(checks: SetupCheck[]) {
  return checks.length > 0 && !checks.some(check => check.status === 'fail')
}

export function validateSetupRepository(repo: string, branch: string) {
  const url = new URL(repo)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || !/^\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(url.pathname)) {
    throw new Error('Select a GitHub HTTPS repository without embedded credentials')
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock')) throw new Error('Invalid branch name')
}
