export type ProjectType = 'next' | 'angular' | 'go' | 'laravel' | 'node'

export const PROJECT_TYPES: Record<ProjectType, {
  label: string
  installCmd: string | null
  buildCmd: string | null
  startCmd: string | null
}> = {
  next: {
    label: 'Next.js',
    installCmd: 'npm install',
    buildCmd: 'npm run build',
    startCmd: 'npm start',
  },
  angular: {
    label: 'Angular',
    installCmd: 'npm install',
    buildCmd: 'npm run build',
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
    startCmd: 'php artisan serve --host=127.0.0.1',
  },
  node: {
    label: 'Node.js',
    installCmd: 'npm install',
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
