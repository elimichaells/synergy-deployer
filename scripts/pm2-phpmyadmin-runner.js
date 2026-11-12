const { createHmac } = require('crypto')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const managerRoot = process.env.MANAGER_ROOT || path.resolve(__dirname, '..')
const envFile = path.join(managerRoot, '.env.local')
const managerConfig = fs.existsSync(envFile) ? require('dotenv').parse(fs.readFileSync(envFile)) : {}

let php = process.env.PHPMYADMIN_PHP || 'php.exe'
// Tools and temporary files sit beside the manager folder unless configured otherwise.
const webRoot = managerConfig.MANAGER_WEB_ROOT || managerConfig.CADDY_PATH || process.env.MANAGER_WEB_ROOT || process.env.CADDY_PATH || path.dirname(managerRoot)
let root = process.env.PHPMYADMIN_ROOT || managerConfig.PHPMYADMIN_ROOT || path.join(managerConfig.MANAGER_TOOLS_ROOT || path.join(webRoot, 'tools'), 'phpmyadmin')
let tempDir = path.join(webRoot, 'temp', 'phpmyadmin')
let sessionDir = path.join(webRoot, 'temp', 'phpmyadmin-sessions')
let privateIni
const activeMarker=path.join(managerConfig.MANAGER_TOOLS_ROOT || process.env.MANAGER_TOOLS_ROOT || path.join(webRoot,'tools'),'phpmyadmin-state','database-browser.json')
if(process.env.MANAGER_OFFLINE_INSTALL!=='1'&&managerConfig.MANAGER_OFFLINE_INSTALL!=='1'&&fs.existsSync(activeMarker)){
  const active=JSON.parse(fs.readFileSync(activeMarker,'utf8'))
  if(![active.clientRoot,active.phpCgi,active.phpIni,active.tempRoot,active.sessionRoot].every(value=>typeof value==='string'&&path.isAbsolute(value)))throw Error('Invalid active database browser release')
  root=active.clientRoot;php=path.join(path.dirname(active.phpCgi),'php.exe');privateIni=active.phpIni;tempDir=active.tempRoot;sessionDir=active.sessionRoot
}
const port = process.env.PHPMYADMIN_PORT || '8433'
const managerDomain = managerConfig.MANAGER_DOMAIN || process.env.MANAGER_DOMAIN || 'deploy.smartcloudgh.com'
const managerAddress = managerDomain.includes(':') && !managerDomain.startsWith('[') ? `[${managerDomain}]` : managerDomain
const managerUrl = managerConfig.MANAGER_URL || process.env.MANAGER_URL || `https://${managerAddress}`
const secret = managerConfig.JWT_SECRET || process.env.JWT_SECRET

if (!secret || !fs.existsSync(path.join(root, 'index.php'))) {
  console.error('JWT_SECRET and an installed phpMyAdmin runtime are required')
  process.exit(1)
}

for (const directory of [tempDir, sessionDir]) {
  fs.mkdirSync(directory, { recursive: true })
}

const child = spawn(php, [...(privateIni?['-c',privateIni]:[]),'-S', `127.0.0.1:${port}`, '-t', root], {
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
    ...(privateIni?{PHPRC:privateIni,PHP_INI_SCAN_DIR:path.join(root,'.ini-scan')}:{}),
    PHPMYADMIN_BLOWFISH_SECRET: createHmac('sha256', secret).update('manager:phpmyadmin').digest('hex'),
    PHPMYADMIN_PUBLIC_URL: `${managerUrl}/mysql/`,
    // phpMyAdmin's config reads these with forward slashes.
    PHPMYADMIN_TEMP_DIR: tempDir.split(path.sep).join('/'),
    PHPMYADMIN_SESSION_DIR: sessionDir.split(path.sep).join('/'),
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
