const { createHmac } = require('crypto')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const managerRoot = process.env.MANAGER_ROOT || path.resolve(__dirname, '..')
const envFile = path.join(managerRoot, '.env.local')
const managerConfig = fs.existsSync(envFile) ? require('dotenv').parse(fs.readFileSync(envFile)) : {}

const php = process.env.PHPMYADMIN_PHP || 'php.exe'
const root = process.env.PHPMYADMIN_ROOT || 'C:/web/tools/phpmyadmin'
const port = process.env.PHPMYADMIN_PORT || '8433'
const managerDomain = managerConfig.MANAGER_DOMAIN || process.env.MANAGER_DOMAIN || 'deploy.smartcloudgh.com'
const secret = managerConfig.JWT_SECRET || process.env.JWT_SECRET

if (!secret || !fs.existsSync(path.join(root, 'index.php'))) {
  console.error('JWT_SECRET and an installed phpMyAdmin runtime are required')
  process.exit(1)
}

for (const directory of ['C:/web/temp/phpmyadmin', 'C:/web/temp/phpmyadmin-sessions']) {
  fs.mkdirSync(directory, { recursive: true })
}

const child = spawn(php, ['-S', `127.0.0.1:${port}`, '-t', root], {
  cwd: root,
  windowsHide: true,
  stdio: 'inherit',
  env: {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    ComSpec: process.env.ComSpec,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    Path: process.env.Path || process.env.PATH,
    PATH: process.env.Path || process.env.PATH,
    PHPMYADMIN_BLOWFISH_SECRET: createHmac('sha256', secret).update('manager:phpmyadmin').digest('hex'),
    PHPMYADMIN_PUBLIC_URL: `https://${managerDomain}/mysql/`,
    PHPMYADMIN_TEMP_DIR: 'C:/web/temp/phpmyadmin',
    PHPMYADMIN_SESSION_DIR: 'C:/web/temp/phpmyadmin-sessions',
    PHPMYADMIN_DB_HOST: managerConfig.PHPMYADMIN_DB_HOST || process.env.PHPMYADMIN_DB_HOST || '127.0.0.1',
    PHPMYADMIN_DB_PORT: managerConfig.PHPMYADMIN_DB_PORT || process.env.PHPMYADMIN_DB_PORT || '3306',
  },
})

child.on('exit', (code, signal) => {
  if (signal) console.error(`phpMyAdmin stopped by ${signal}`)
  process.exit(code ?? 1)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
