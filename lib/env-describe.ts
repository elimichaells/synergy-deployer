/** Browser-safe helpers for showing environment variable names. */
export interface EnvFileSummary {
  file: string
  exists: boolean
  /** Variable names only. Values never leave the server through this summary. */
  names: string[]
}

/** Plain-language guess at what a variable is for, so beginners can tell what they are looking at. */
export function describeEnvName(name: string): string | null {
  const upper = name.toUpperCase()
  if (/^(DATABASE|POSTGRES|MYSQL|DB_|MONGO|REDIS)/.test(upper)) return 'Database connection'
  if (/(SECRET|TOKEN|KEY|PASSWORD|PASS)$|^JWT|_SECRET|_TOKEN|_API_KEY/.test(upper)) return 'Secret'
  if (/^(SMTP|MAIL|EMAIL)/.test(upper)) return 'Email'
  if (/(URL|HOST|DOMAIN|ORIGIN)$/.test(upper)) return 'Address'
  if (/^(NODE_ENV|APP_ENV|PORT|NEXT_PUBLIC)/.test(upper)) return 'App setting'
  return null
}
