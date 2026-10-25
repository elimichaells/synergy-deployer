export type EnvironmentMode = 'production' | 'staging' | 'production-staging'

/** Accept older API clients while keeping an explicit choice in the setup flow. */
export function environmentMode(body: { environmentMode?: unknown; createStaging?: unknown; setupDraft?: unknown }): EnvironmentMode {
  if (body.createStaging !== undefined && typeof body.createStaging !== 'boolean') throw new Error('Invalid staging selection')
  if (body.environmentMode !== undefined) {
    if (!['production', 'staging', 'production-staging'].includes(body.environmentMode as string)) throw new Error('Choose production only, staging only, or production + staging')
    if (body.createStaging !== undefined && body.createStaging !== (body.environmentMode === 'production-staging')) throw new Error('Conflicting environment selections')
    return body.environmentMode as EnvironmentMode
  }
  if (body.setupDraft === true && body.createStaging === undefined) throw new Error('Choose production only, staging only, or production + staging')
  return body.createStaging ? 'production-staging' : 'production'
}

/** A paired staging copy follows its parent; standalone staging is an app in its own right. */
export function isApplicationRoot(app: { environment: string; production_id?: string | null }) {
  return app.environment === 'production' || !app.production_id
}

export function projectEnvironment(apps: { environment: 'production' | 'staging' }[], preferred: 'production' | 'staging') {
  return apps.some(app => app.environment === preferred) ? preferred : apps[0]?.environment || preferred
}
