import { NextResponse } from 'next/server'
import { spawn } from 'child_process'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { killProcessTree } from '@/lib/exec'

export const dynamic = 'force-dynamic'

const COMMAND_TIMEOUT_MS = 600_000 // 10 minutes

// Only package-manager commands are allowed; no shell chaining or redirection.
const ALLOWED_PREFIX = /^(npm|npx|pnpm|yarn)(\s|$)/
const FORBIDDEN_CHARS = /[;&|<>`$\\\r\n]/

// Survives module duplication between route bundles: projectId -> pid
const runningCommands: Map<string, number> =
  ((globalThis as unknown as { __siteNpmRunners?: Map<string, number> }).__siteNpmRunners ??= new Map())

function validateCommand(command: string): string | null {
  const trimmed = command.trim()
  if (!trimmed) return 'Command is empty'
  if (trimmed.length > 500) return 'Command too long'
  if (!ALLOWED_PREFIX.test(trimmed)) {
    return 'Only npm, npx, pnpm and yarn commands are allowed'
  }
  if (FORBIDDEN_CHARS.test(trimmed)) {
    return 'Command contains forbidden characters (no chaining, piping or redirection)'
  }
  return null
}

async function getProjectRoot(id: string) {
  const { rows } = await query<{ root_path: string; name: string }>(
    'select root_path, name from projects where id = $1',
    [id]
  )
  return rows[0] ?? null
}

/** GET: list the package.json scripts of the site so the UI can offer quick actions */
export async function GET(_request: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])

    const project = await getProjectRoot(context.params.id)
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const pkgPath = path.join(project.root_path, 'package.json')
    if (!existsSync(pkgPath)) {
      return NextResponse.json({ scripts: {}, hasPackageJson: false, running: runningCommands.has(context.params.id) })
    }

    let scripts: Record<string, string> = {}
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
      scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {}
    } catch {
      // malformed package.json — still allow raw commands
    }

    return NextResponse.json({
      scripts,
      hasPackageJson: true,
      running: runningCommands.has(context.params.id),
    })
  } catch (error) {
    return jsonError(error)
  }
}

/** POST: run an npm command in the site's root path, streaming output as plain text chunks */
export async function POST(request: Request, context: { params: { id: string } }) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])

    const body = await request.json().catch(() => null)
    const command: string = (body?.command || '').trim()

    const validationError = validateCommand(command)
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 })
    }

    const projectId = context.params.id
    const project = await getProjectRoot(projectId)
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    if (!existsSync(project.root_path)) {
      return NextResponse.json({ error: `Root path does not exist: ${project.root_path}` }, { status: 400 })
    }
    if (runningCommands.has(projectId)) {
      return NextResponse.json({ error: 'A command is already running for this site' }, { status: 409 })
    }

    const encoder = new TextEncoder()
    let childPid: number | undefined
    let timer: NodeJS.Timeout | null = null

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      runningCommands.delete(projectId)
    }

    const stream = new ReadableStream({
      start(controller) {
        const child = spawn(command, {
          cwd: project.root_path,
          shell: true,
          windowsHide: true,
          env: {
            ...process.env,
            FORCE_COLOR: '0',
            NO_COLOR: '1',
            // devDependencies must install even when the manager runs in production
            NODE_ENV: 'development',
          },
        })

        childPid = child.pid
        if (child.pid) runningCommands.set(projectId, child.pid)

        const write = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text))
          } catch {
            // stream already closed (client disconnected)
          }
        }

        write(`$ ${command}\n[cwd] ${project.root_path}\n\n`)

        timer = setTimeout(() => {
          write(`\n[timeout] Command killed after ${COMMAND_TIMEOUT_MS / 1000}s\n`)
          if (child.pid) killProcessTree(child.pid)
        }, COMMAND_TIMEOUT_MS)

        child.stdout.on('data', (data) => write(data.toString()))
        child.stderr.on('data', (data) => write(data.toString()))

        child.on('error', (error) => {
          write(`\n[error] ${error.message}\n`)
          cleanup()
          try { controller.close() } catch { /* already closed */ }
        })

        child.on('close', (code) => {
          write(`\n[exit] Command finished with code ${code ?? 0}\n`)
          cleanup()
          try { controller.close() } catch { /* already closed */ }
        })
      },
      cancel() {
        // Client aborted the request — kill the process tree
        cleanup()
        if (childPid) killProcessTree(childPid)
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    })
  } catch (error) {
    return jsonError(error)
  }
}
