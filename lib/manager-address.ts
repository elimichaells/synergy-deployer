import { isIP } from 'node:net'

export function normalizeManagerAddress(input: string): string {
  let address = input.trim().toLowerCase().replace(/\.$/, '')
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1)
  if (/[\s/%]/.test(address)) throw new Error('Invalid Manager address')
  if (isIP(address)) return address
  if (/^[0-9.]+$/.test(address) || !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(address)) {
    throw new Error('Invalid Manager address')
  }
  return address
}

export function managerSiteAddress(address: string): string {
  const normalized = normalizeManagerAddress(address)
  return isIP(normalized) === 6 ? `[${normalized}]` : normalized
}

export function managerUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `https://${managerSiteAddress(env.MANAGER_DOMAIN || 'deploy.smartcloudgh.com')}`
}

export function isManagerAddress(address: string): boolean {
  return normalizeManagerAddress(address) === normalizeManagerAddress(process.env.MANAGER_DOMAIN || 'deploy.smartcloudgh.com')
}

export function managerUsesLocalTls(address: string): boolean {
  const normalized = normalizeManagerAddress(address)
  return process.env.MANAGER_TLS_MODE === 'internal' || process.env.MANAGER_ACCESS_MODE === 'local'
    || !!isIP(normalized) || !normalized.includes('.') || /\.(localhost|local|internal|test|invalid|home\.arpa)$/.test(normalized)
}
