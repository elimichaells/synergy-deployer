const { execFile, spawn } = require('child_process')

const command = process.env.MANAGER_WORKER_CMD
const cwd = process.env.MANAGER_WORKER_CWD || process.cwd()

if (!command) {
  console.error('MANAGER_WORKER_CMD is required')
  process.exit(1)
}

const child = spawn(command, {
  cwd,
  shell: true,
  windowsHide: true,
  stdio: 'inherit',
  env: process.env,
})

const shutdown = () => {
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }, () => {})
    return
  }
  if (!child.killed) child.kill()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 0)
})

child.on('error', (error) => {
  console.error(error)
  process.exit(1)
})
