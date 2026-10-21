import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { managerDataRoot, managerScript } from './paths'
import { ApiError } from './api'
import type { Command } from './exec'

export const offlineServices = ['mysql', 'mariadb', 'mongodb', 'sqlserver', 'phpmyadmin'] as const
export function offlineMode() { return process.env.MANAGER_OFFLINE_INSTALL === '1' }
export function serviceStateRoot(id: string) {
  if (!(offlineServices as readonly string[]).includes(id)) throw new ApiError('Unsupported offline service', 400)
  return path.join(managerDataRoot(), 'services', id)
}
export function offlineServiceReceipt(id: string): { engine: string; version: string; phase: string; port: number; executable: string } | null {
  if (!(offlineServices as readonly string[]).includes(id) || id === 'phpmyadmin') return null
  try { return JSON.parse(readFileSync(path.join(serviceStateRoot(id), 'service.json'), 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}
export function offlinePackage(id: string) {
  try {
    const root = path.join(managerDataRoot(), 'offline-services')
    const manifest = JSON.parse(readFileSync(path.join(root, 'services.json'), 'utf8').replace(/^\uFEFF/, '')) as { artifacts: Array<{ id: string; version: string; file: string }> }
    const item = manifest.artifacts.find(item => item.id === id)
    return item && /^[a-z0-9.-]+$/i.test(item.file) && existsSync(path.join(root, item.file)) ? item : null
  } catch { return null }
}
export function offlineCommand(id: string, action: string): Command {
  if (!(offlineServices as readonly string[]).includes(id)) throw new ApiError(id === 'redis' ? 'Connect an existing Redis server under Data connections.' : 'This dependency is not in the offline service bundle.', 409)
  if (action !== 'install' && action !== 'configure') throw new ApiError('Offline database upgrades are disabled. Import a reviewed release during a maintenance window.', 409)
  if (action === 'configure' && id === 'phpmyadmin') throw new ApiError('Use the phpMyAdmin service status to verify this client.', 409)
  if (!offlinePackage(id) && action === 'install') throw new ApiError('The offline service package is missing. Import the service bundle on this server first.', 409)
  return { file: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', managerScript('offline-service.ps1'),
    '-Engine', id, '-Action', action === 'configure' ? 'Verify' : 'Install',
  ] }
}
