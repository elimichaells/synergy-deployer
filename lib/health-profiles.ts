import { readFile, writeFile, rename } from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import { managerDataRoot } from '@/lib/paths'
import { validateHealthProfile, type HealthProfile } from '../scripts/http-health.cjs'

const configFile = () => process.env.MANAGER_MONITOR_CONFIG || path.join(managerDataRoot(), 'monitor', 'config.json')
export async function applicationHealthProfile(name: string): Promise<HealthProfile> {
  let config
  try { config = JSON.parse((await readFile(configFile(), 'utf8')).replace(/^\uFEFF/, '')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return validateHealthProfile(); throw new Error('Health configuration is unavailable; check Server health') }
  return validateHealthProfile(config.applications?.[name])
}
let pending: Promise<unknown> = Promise.resolve()
export function saveApplicationHealthProfile(name: string, input: unknown) {
  const profile = validateHealthProfile(input)
  const operation = pending.catch(() => {}).then(async () => {
    const file = configFile()
    const config = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''))
    config.applications = { ...config.applications, [name]: profile }
    const temporary = file + '.' + randomUUID() + '.tmp'
    await writeFile(temporary, JSON.stringify(config, null, 2), { flag: 'wx' })
    await rename(temporary, file)
    return profile
  })
  pending = operation
  return operation
}
