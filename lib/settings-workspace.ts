export const SETTINGS_SECTIONS = [
  { id: 'account', group: 'Personal', label: 'Your account', description: 'Who you are signed in as and what you can do.' },
  { id: 'access', group: 'Workspace', label: 'Team & access', description: 'Everyone who can sign in to Synergy, and their roles.' },
  { id: 'integrations', group: 'Workspace', label: 'Connections', description: 'Everything Synergy is connected to: GitHub, Cloudflare and database servers.' },
  { id: 'notifications', group: 'Workspace', label: 'Notifications', description: 'Where Synergy sends a message after each deployment.' },
  { id: 'general', group: 'Server', label: 'App folders', description: 'Where Synergy puts the code of apps you add from now on.' },
  { id: 'backups', group: 'Server', label: 'Backups', description: 'Where PostgreSQL backups are stored and how long they are kept.' },
] as const

/** Sections that moved elsewhere keep working as links. */
export const MOVED_SETTINGS_SECTIONS: Record<string, string> = { runtimes: '/infrastructure/runtimes' }

export type SettingsSection = typeof SETTINGS_SECTIONS[number]['id']
export const EDITABLE_SETTINGS = {
  PRODUCTION_PATH: '', STAGING_PATH: '',
  NOTIFY_WEBHOOK_URL: '', BACKUP_DIR: '', BACKUP_ENABLED: 'false',
  BACKUP_RETENTION_DAYS: '14', PG_BIN_PATH: '',
}
export type SettingsForm = typeof EDITABLE_SETTINGS
export type SettingsField = keyof SettingsForm
export const SECTION_FIELDS: Record<SettingsSection, SettingsField[]> = {
  general: ['PRODUCTION_PATH', 'STAGING_PATH'],
  account: [], integrations: [], notifications: ['NOTIFY_WEBHOOK_URL'],
  backups: ['BACKUP_DIR', 'BACKUP_ENABLED', 'BACKUP_RETENTION_DAYS', 'PG_BIN_PATH'], access: [],
}

export function settingsSection(value: string | null): SettingsSection {
  return SETTINGS_SECTIONS.find(section => section.id === value)?.id || 'account'
}

export function settingsForm(value: unknown): SettingsForm {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings response')
  const record = value as Record<string, unknown>
  const result = { ...EDITABLE_SETTINGS }
  for (const field of Object.keys(result) as SettingsField[]) {
    if (typeof record[field] !== 'string') throw new Error('Incomplete settings response. Reload before editing.')
    result[field] = record[field]
  }
  return result
}

export function settingsChanges(section: SettingsSection, saved: SettingsForm, draft: SettingsForm) {
  return Object.fromEntries(SECTION_FIELDS[section].filter(key => draft[key] !== saved[key]).map(key => [key, draft[key]])) as Partial<SettingsForm>
}

export function validateSettingsSection(section: SettingsSection, form: SettingsForm): string | null {
  const paths = section === 'general' ? SECTION_FIELDS.general : section === 'backups' ? ['BACKUP_DIR', 'PG_BIN_PATH'] as const : []
  if (paths.some(key => !form[key as SettingsField].trim())) return 'Enter a value for each directory path.'
  if (section === 'backups' && (!/^\d+$/.test(form.BACKUP_RETENTION_DAYS) || Number(form.BACKUP_RETENTION_DAYS) < 1 || Number(form.BACKUP_RETENTION_DAYS) > 3650)) return 'Retention must be a whole number between 1 and 3650 days.'
  if (section === 'notifications' && form.NOTIFY_WEBHOOK_URL) {
    try {
      const url = new URL(form.NOTIFY_WEBHOOK_URL)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return 'Enter an HTTP or HTTPS webhook URL without embedded account credentials.'
    } catch { return 'Enter a valid webhook URL, or leave it empty to disable notifications.' }
  }
  return null
}

export function runtimeCategory(id: string) {
  if (['node', 'php', 'go', 'python', 'angular', 'composer'].includes(id)) return 'languages'
  if (['postgresql', 'mysql', 'mariadb', 'sqlserver', 'mongodb', 'redis'].includes(id)) return 'databases'
  return 'tools'
}
