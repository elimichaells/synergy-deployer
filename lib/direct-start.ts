/**
 * Whether an app can be started by PM2 directly instead of through the manager's runner, which
 * costs a Node process, two shells and often an npm process per app. Pure, with file access
 * passed in, so the rules are testable.
 */

export interface DirectStart {
  /** Absolute path PM2 starts. */
  script: string
  /** 'node' for a Node script, 'none' for a native executable. */
  interpreter: 'node' | 'none'
  args: string[]
  /** Variables the start command set itself (`cross-env NAME=value`). */
  env: Record<string, string>
}

export interface DirectStartInput {
  startCmd: string | null
  projectType: string
  port: number | null
  /** A pinned Node version needs the runner: PM2 always uses its own Node for `--interpreter node`. */
  nodePinned: boolean
  root: string
  scripts: Record<string, string> | null
  exists: (absolutePath: string) => boolean
  read: (absolutePath: string) => string | null
  join: (...parts: string[]) => string
}

export type DirectStartPlan = { direct: DirectStart; reason: null } | { direct: null; reason: string }

const no = (reason: string): DirectStartPlan => ({ direct: null, reason })
const SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./\\-]+$/
const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_@%+=:,./\\-]*)$/

export function planDirectStart(input: DirectStartInput): DirectStartPlan {
  if (input.nodePinned) return no('Pins its own Node.js version')
  if (input.projectType === 'laravel') return no('PHP apps keep the runner')
  let command = (input.startCmd || '').trim()
  if (!command) return no('No start command')

  // npm start / npm run <name> runs a package.json script; npm itself is the overhead to remove.
  const npm = /^npm(?:\.cmd)?\s+(?:start|run\s+([A-Za-z0-9:_-]+))$/.exec(command)
  if (npm) {
    const name = npm[1] || 'start'
    if (!input.scripts) return no('package.json could not be read')
    if (input.scripts[`pre${name}`] || input.scripts[`post${name}`]) return no(`npm runs "pre${name}" or "post${name}" around it`)
    if (!input.scripts[name]) return no(`package.json has no "${name}" script`)
    command = input.scripts[name].trim()
  }

  const tokens = command.split(/\s+/)
  if (tokens.some(token => !SAFE_TOKEN.test(token))) return no('Uses shell features such as quotes, pipes or chained commands')
  const env: Record<string, string> = {}
  if (tokens[0] === 'cross-env') {
    tokens.shift()
    while (tokens.length && ENV_ASSIGNMENT.test(tokens[0])) {
      const [, key, value] = ENV_ASSIGNMENT.exec(tokens.shift()!)!
      env[key] = value
    }
  }
  if (!tokens.length) return no('No program to start')
  const [program, ...rest] = tokens

  if (program === 'next') {
    if (rest[0] !== 'start') return no('Only "next start" can run directly')
    const script = input.join(input.root, 'node_modules', 'next', 'dist', 'bin', 'next')
    if (!input.exists(script)) return no('Next.js is not installed in the app folder')
    // The assigned port always wins, as it does for every other start.
    const args = ['start']
    for (let index = 1; index < rest.length; index++) {
      if (rest[index] === '-p' || rest[index] === '--port') { index++; continue }
      if (/^--port=/.test(rest[index])) continue
      args.push(rest[index])
    }
    if (input.port) args.push('-p', String(input.port))
    return { direct: { script, interpreter: 'node', args, env }, reason: null }
  }

  if (program === 'node') {
    const flags: string[] = []
    let index = 0
    while (index < rest.length && rest[index].startsWith('-')) flags.push(rest[index++])
    if (index >= rest.length) return no('No script after "node"')
    if (flags.some(flag => !/^--[a-z0-9-]+(=[A-Za-z0-9_.:/-]+)?$/.test(flag))) return no('Uses Node options the runner must pass')
    let script = input.join(input.root, rest[index])
    if (!input.exists(script) && input.exists(`${script}.js`)) script = `${script}.js`
    if (!input.exists(script)) return no(`${rest[index]} does not exist yet`)
    // A script that starts its own child process may leave it running when PM2 stops the parent.
    const source = input.read(script)
    if (source === null) return no(`${rest[index]} could not be read`)
    if (/child_process|\bspawn\s*\(|\bfork\s*\(|\bexec(?:File)?\s*\(/.test(source)) return no(`${rest[index]} starts another process`)
    if (flags.length) env.NODE_OPTIONS = [env.NODE_OPTIONS, ...flags].filter(Boolean).join(' ')
    return { direct: { script, interpreter: 'node', args: rest.slice(index + 1), env }, reason: null }
  }

  if (/\.exe$/i.test(program) && Object.keys(env).length === 0) {
    const script = input.join(input.root, program.replace(/^\.[\\/]/, ''))
    if (!input.exists(script)) return no(`${program} does not exist yet`)
    return { direct: { script, interpreter: 'none', args: rest, env }, reason: null }
  }

  return no(`"${program}" is not a program that can run directly`)
}

/** The PM2 command for a direct start. Tokens are already restricted to characters that need no quoting. */
export function directStartCommand(direct: DirectStart, pm2Name: string) {
  return `pm2 start "${direct.script}" --interpreter ${direct.interpreter} --name "${pm2Name}" --kill-timeout 15000${direct.args.length ? ` -- ${direct.args.join(' ')}` : ''}`
}
