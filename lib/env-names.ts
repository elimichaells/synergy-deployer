import { parse } from 'dotenv'
import type { EnvFileSummary } from '@/lib/env-describe'

export type { EnvFileSummary }

/** The names defined in an env file, in file order. Values are discarded. */
export function envNames(content: string): string[] {
  return Object.keys(parse(content)).filter(name => /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name))
}
