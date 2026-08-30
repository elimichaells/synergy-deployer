import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { runCommand } from '@/lib/exec'
import { getSetting } from '@/lib/settings'
import { readFile, stat } from 'fs/promises'

type CaddyMode = 'pm2' | 'service' | 'cli' | 'unknown'
type CaddyStatus = 'running' | 'stopped' | 'unknown'

const CADDY_ADMIN_URL = 'http://127.0.0.1:2019'

async function getCaddyBase() {
  return await getSetting('CADDY_PATH')
}

async function getCaddyExe() {
  const base = await getCaddyBase()
  return `"${base}\\caddy.exe"`
}

async function getConfigPath() {
  const explicit = process.env.CADDYFILE_PATH || process.env.CADDY_CONFIG
  if (explicit) return explicit
  const base = await getCaddyBase()
  return `${base}\\Caddyfile`
}

async function isCaddyRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${CADDY_ADMIN_URL}/config/`, {
      signal: AbortSignal.timeout(2000),
    })
    return res.ok
  } catch {
    return false
  }
}

async function detectWindowsService(): Promise<CaddyStatus | null> {
  const result = await runCommand('sc query caddy')
  if (result.code !== 0) return null
  const output = result.output.toUpperCase()
  if (output.includes('RUNNING')) return 'running'
  if (output.includes('STOPPED')) return 'stopped'
  return 'stopped'
}

async function detectPm2() {
  const result = await runCommand('pm2 jlist')
  if (result.code !== 0) return null
  const list = JSON.parse(result.output) as Array<{
    name: string
    pm2_env?: { status?: string }
  }>
  const match = list.find((item) => item.name === 'caddy')
  if (!match) return null
  return match.pm2_env?.status || 'unknown'
}

export async function GET(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])

    const includeConfig = new URL(request.url).searchParams.get('includeConfig') === '1'
    let configDetails: { config: string; configSize: number; configModifiedAt: string } | undefined

    if (includeConfig) {
      requireRole(user, ['admin'])
      const configPath = await getConfigPath()
      const configStat = await stat(configPath)
      if (configStat.size > 1024 * 1024) {
        return NextResponse.json({ error: 'Caddyfile is too large to display' }, { status: 413 })
      }
      configDetails = {
        config: await readFile(configPath, 'utf8'),
        configSize: configStat.size,
        configModifiedAt: configStat.mtime.toISOString(),
      }
    }

    const pm2Status = await detectPm2()
    if (pm2Status) {
      return NextResponse.json({
        mode: 'pm2' as CaddyMode,
        status: pm2Status,
        configPath: await getConfigPath(),
        ...configDetails,
      })
    }

    const serviceStatus = await detectWindowsService()
    if (serviceStatus) {
      const version = await runCommand(`${await getCaddyExe()} version`)
      return NextResponse.json({
        mode: 'service' as CaddyMode,
        status: serviceStatus,
        configPath: await getConfigPath(),
        ...(version.code === 0 && { version: version.output.trim() }),
        ...configDetails,
      })
    }

    const running = await isCaddyRunning()
    const version = await runCommand(`${await getCaddyExe()} version`)

    if (version.code === 0) {
      return NextResponse.json({
        mode: 'cli' as CaddyMode,
        status: (running ? 'running' : 'stopped') as CaddyStatus,
        configPath: await getConfigPath(),
        version: version.output.trim(),
        ...configDetails,
      })
    }

    return NextResponse.json({
      mode: 'unknown' as CaddyMode,
      status: 'unknown' as CaddyStatus,
      configPath: await getConfigPath(),
      ...configDetails,
    })
  } catch (error) {
    return jsonError(error)
  }
}

export async function POST(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])

    const body = await request.json().catch(() => null)
    const action = body?.action as string | undefined
    if (!action || !['start', 'stop', 'reload', 'restart', 'validate'].includes(action)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }

    const caddyExe = await getCaddyExe()
    const configPath = await getConfigPath()

    if (action === 'validate') {
      const result = await runCommand(`${caddyExe} validate --config "${configPath}" --adapter caddyfile`)
      return NextResponse.json(
        { mode: 'validation', valid: result.code === 0, output: result.output },
        { status: result.code === 0 ? 200 : 422 },
      )
    }

    const pm2Status = await detectPm2()
    if (pm2Status) {
      const pm2Action = action === 'reload' ? 'restart' : action
      const result = await runCommand(`pm2 ${pm2Action} caddy`)
      return NextResponse.json({ mode: 'pm2', output: result.output })
    }

    const serviceStatus = await detectWindowsService()
    if (serviceStatus) {
      if (action === 'start') {
        if (serviceStatus === 'running') {
          return NextResponse.json({ mode: 'service', output: 'Caddy service is already running.' })
        }
        const result = await runCommand('sc start caddy')
        return NextResponse.json({ mode: 'service', output: result.output })
      }
      if (action === 'stop') {
        const result = await runCommand('sc stop caddy')
        return NextResponse.json({ mode: 'service', output: result.output })
      }
      if (action === 'reload') {
        const running = await isCaddyRunning()
        if (!running) {
          const result = await runCommand('sc start caddy')
          return NextResponse.json({ mode: 'service', output: result.output })
        }
        const result = await runCommand(`${caddyExe} reload --config "${configPath}" --adapter caddyfile`)
        return NextResponse.json({ mode: 'service', output: result.output })
      }
      if (action === 'restart') {
        await runCommand('sc stop caddy')
        await new Promise((r) => setTimeout(r, 2000))
        const result = await runCommand('sc start caddy')
        return NextResponse.json({ mode: 'service', output: result.output })
      }
    }

    const running = await isCaddyRunning()

    if (action === 'start') {
      if (running) {
        return NextResponse.json({ mode: 'cli', output: 'Caddy is already running. Use reload to apply config changes.' })
      }
      const result = await runCommand(`${caddyExe} start --config "${configPath}" --adapter caddyfile`)
      return NextResponse.json({ mode: 'cli', output: result.output })
    }
    if (action === 'stop') {
      const result = await runCommand(`${caddyExe} stop`)
      return NextResponse.json({ mode: 'cli', output: result.output })
    }
    if (action === 'reload') {
      if (!running) {
        const result = await runCommand(`${caddyExe} start --config "${configPath}" --adapter caddyfile`)
        return NextResponse.json({ mode: 'cli', output: result.output })
      }
      const result = await runCommand(`${caddyExe} reload --config "${configPath}" --adapter caddyfile`)
      return NextResponse.json({ mode: 'cli', output: result.output })
    }
    if (action === 'restart') {
      if (running) {
        await runCommand(`${caddyExe} stop`)
      }
      const result = await runCommand(`${caddyExe} start --config "${configPath}" --adapter caddyfile`)
      return NextResponse.json({ mode: 'cli', output: result.output })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    return jsonError(error)
  }
}
