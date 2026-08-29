const { createHmac } = require('crypto')
const { spawn } = require('child_process')
const path = require('path')

const managerRoot = process.env.MANAGER_ROOT || path.resolve(__dirname, '..')
require('dotenv').config({ path: path.join(managerRoot, '.env.local'), quiet: true })
const executable = process.env.PGWEB_EXE || 'C:\\web\\tools\\pgweb\\pgweb.exe'
const secret = process.env.JWT_SECRET

if (!secret) {
  console.error('JWT_SECRET is required to start Pgweb')
  process.exit(1)
}

const connectToken = createHmac('sha256', secret).update('manager:pgweb-connect').digest('base64url')
const child = spawn(executable, [
  '/bind:127.0.0.1',
  '/listen:8432',
  '/sessions',
  '/skip-open',
  '/prefix:postgres',
  '/no-ssh',
  '/idle-timeout:30',
  '/query-timeout:120',
  '/connect-backend:http://127.0.0.1:4000/api/auth/pgweb-connect',
  `/connect-token:${connectToken}`,
], {
  cwd: managerRoot,
  windowsHide: true,
  stdio: 'inherit',
})

child.on('exit', (code, signal) => {
  if (signal) console.error(`Pgweb stopped by ${signal}`)
  process.exit(code ?? 1)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
