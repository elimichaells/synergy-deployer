export function customStartupWarning(projectType: string | null | undefined, configured: string | null, scripts: Record<string, string> | undefined) {
  if (projectType !== 'next' || configured || !scripts?.start) return null
  if (/^next\s+start(?:\s+--?(?:port|p|hostname|H)\s+[^\s]+)*$/.test(scripts.start.trim())) return null
  return 'This application has a custom package.json start script, but Manager is configured to start Next.js directly. Set Start command to "npm run start" to preserve the application startup steps, then deploy again.'
}
