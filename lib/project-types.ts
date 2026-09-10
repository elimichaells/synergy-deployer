export type ProjectType = 'next' | 'angular' | 'go' | 'laravel' | 'node'

export const PROJECT_TYPES: Record<ProjectType, {
  label: string
  installCmd: string | null
  buildCmd: string | null
  startCmd: string | null
}> = {
  next: {
    label: 'Next.js',
    installCmd: null,
    buildCmd: 'npm run build',
    startCmd: 'npm start',
  },
  angular: {
    label: 'Angular',
    installCmd: null,
    buildCmd: 'npm run build -- --configuration production',
    startCmd: null,
  },
  go: {
    label: 'Go',
    installCmd: 'go mod download',
    buildCmd: 'go build -o app.exe .',
    startCmd: '.\\app.exe',
  },
  laravel: {
    label: 'Laravel',
    installCmd: 'composer install --no-dev --optimize-autoloader',
    buildCmd: 'php artisan config:cache && php artisan route:cache && php artisan view:cache',
    startCmd: 'php artisan serve --host=127.0.0.1 --no-reload --tries=1',
  },
  node: {
    label: 'Node.js',
    installCmd: null,
    buildCmd: 'npm run build',
    startCmd: 'npm start',
  },
}

export function normalizeProjectType(value: unknown): ProjectType {
  return value === 'angular' || value === 'go' || value === 'laravel' || value === 'node'
    ? value
    : 'next'
}

export function getProjectTypeDefaults(value: unknown) {
  return PROJECT_TYPES[normalizeProjectType(value)]
}

export function getProjectCommandOverrides(project: {
  install_cmd?: string | null
  build_cmd?: string | null
  start_cmd?: string | null
}) {
  // Empty form fields represent inherited defaults, not persisted npm commands.
  return {
    installCmd: project.install_cmd ?? '',
    buildCmd: project.build_cmd ?? '',
    startCmd: project.start_cmd ?? '',
  }
}

export function getProjectPortEnvironment(projectType: unknown, port: number | null): Record<string, string> {
  if (!port) return {}
  const value = String(port)
  // Go applications commonly read APP_PORT instead of the conventional PORT.
  return normalizeProjectType(projectType) === 'go' ? { PORT: value, APP_PORT: value } : { PORT: value }
}
