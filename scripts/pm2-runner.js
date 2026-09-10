const { execFile, spawn } = require('child_process')

const command = process.env.MANAGER_START_CMD
const cwd = process.env.MANAGER_APP_CWD || process.cwd()

// The manager is itself a Next.js application, so its process environment can
// contain this internal marker. Passing it to a managed Next.js application
// makes @next/env assume that application's .env files were already loaded.
const childEnv = { ...process.env }
delete childEnv.__NEXT_PROCESSED_ENV

if (!command) {
  console.error('MANAGER_START_CMD is required')
  process.exit(1)
}

const child = spawn(command, {
  cwd,
  shell: true,
  windowsHide: true,
  stdio: 'inherit',
  env: childEnv,
})

let stopping = false
let killingTree = false
let childExit
const finish = () => {
  if (killingTree || !childExit) return
  process.exit(stopping ? 0 : (childExit.code ?? 1))
}

const shutdown = () => {
  if (stopping) return
  stopping = true
  if (process.platform === 'win32' && child.pid) {
    killingTree = true
    execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, timeout: 10000 }, (error) => {
      killingTree = false
      if (error && !childExit) console.error('Application process tree shutdown failed')
      finish()
    })
    return
  }
  if (!child.killed) child.kill()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('message', (message) => { if (message === 'shutdown') shutdown() })

child.on('exit', (code, signal) => {
  childExit = { code, signal }
  finish()
})

child.on('error', (error) => {
  console.error(error)
  process.exit(1)
})
