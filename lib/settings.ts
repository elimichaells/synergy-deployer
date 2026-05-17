import { query } from '@/lib/db'

export type SettingKey =
  | 'PRODUCTION_PATH'
  | 'STAGING_PATH'
  | 'LOGS_PATH'
  | 'CADDY_PATH'
  | 'GITHUB_TOKEN'

const DEFAULTS: Record<SettingKey, string> = {
  PRODUCTION_PATH: 'C:\\web\\production',
  STAGING_PATH: 'C:\\web\\staging',
  LOGS_PATH: 'C:\\web\\logs',
  CADDY_PATH: 'C:\\web',
  GITHUB_TOKEN: '',
}

// In-memory cache with TTL
let cache: Map<string, string> | null = null
let cacheLoadedAt = 0
const CACHE_TTL_MS = 60_000

async function ensureCache(): Promise<Map<string, string>> {
  const now = Date.now()
  if (cache && now - cacheLoadedAt < CACHE_TTL_MS) {
    return cache
  }
  const { rows } = await query<{ key: string; value: string }>('SELECT key, value FROM settings')
  cache = new Map(rows.map((r) => [r.key, r.value]))
  cacheLoadedAt = now
  return cache
}

export function invalidateSettingsCache() {
  cache = null
  cacheLoadedAt = 0
}

export async function getSetting(key: SettingKey): Promise<string> {
  const c = await ensureCache()
  return c.get(key) ?? DEFAULTS[key]
}

export async function getSettings(): Promise<Record<SettingKey, string>> {
  const c = await ensureCache()
  const result = { ...DEFAULTS }
  for (const [k, v] of c.entries()) {
    if (k in DEFAULTS) {
      result[k as SettingKey] = v
    }
  }
  return result
}

export async function updateSettings(updates: Partial<Record<SettingKey, string>>): Promise<void> {
  for (const [key, value] of Object.entries(updates)) {
    if (!(key in DEFAULTS)) continue
    await query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
      [key, value]
    )
  }
  invalidateSettingsCache()
}

/** One-time seeder: copies process.env values into DB rows that don't yet exist */
export async function seedSettingsFromEnv(): Promise<void> {
  const envMap: Record<SettingKey, string | undefined> = {
    PRODUCTION_PATH: process.env.PRODUCTION_PATH,
    STAGING_PATH: process.env.STAGING_PATH,
    LOGS_PATH: process.env.LOGS_PATH,
    CADDY_PATH: process.env.CADDY_PATH,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  }
  for (const [key, envValue] of Object.entries(envMap)) {
    if (!envValue) continue
    await query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO NOTHING`,
      [key, envValue]
    )
  }
  invalidateSettingsCache()
}
