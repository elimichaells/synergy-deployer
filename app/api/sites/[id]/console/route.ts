import { NextResponse } from 'next/server'
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { runCommand } from '@/lib/exec'
import { validateConsoleCommand, projectQuickCommands, readProjectEnvironment, resolveConsoleWorkingDirectory, prepareConsoleCommand } from '@/lib/project-console'
import { projectRuntimeEnvironment } from '@/lib/runtimes'
import { getProjectDatabaseEnv } from '@/lib/project-databases'
import { getProjectDataServiceEnv } from '@/lib/data-services'
import { acquireProjectOperation } from '@/lib/project-operation'
import { prepareConsoleGit, consoleGitFailureHint } from '@/lib/project-console-git'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }
async function project(id: string) {
  const { rows } = await query('select id,root_path,project_type,runtime_versions,port,repo_url,github_connection_id from projects where id=$1', [id])
  if (!rows[0]) throw new ApiError('Application not found', 404)
  return rows[0]
}

export async function GET(request: Request, context: Context) {
  try {
    requireRole(await getSessionFromCookie(), ['admin', 'operator', 'viewer'])
    const app = await project((await context.params).id)
    let scripts: Record<string, string> = {}
    try { scripts = JSON.parse(await readFile(path.join(app.root_path, 'package.json'), 'utf8')).scripts || {} } catch { /* A package manifest is optional. */ }
    scripts = Object.fromEntries(Object.entries(scripts).filter(([name, command]) => typeof command === 'string' && !validateConsoleCommand(`npm run ${name}`)))
    let entries: string[] = []
    try {
      const requestedCwd = new URL(request.url).searchParams.get('cwd')
      const cwd = await resolveConsoleWorkingDirectory(app.root_path, requestedCwd || app.root_path)
      entries = (await readdir(cwd, { withFileTypes: true })).slice(0, 500).map(entry => `${entry.name}${entry.isDirectory() ? '\\' : ''}`).sort((a, b) => a.localeCompare(b))
    } catch { /* Completion is optional; initial console data should still load. */ }
    return NextResponse.json({ scripts, commands: projectQuickCommands(app.project_type), runtimeVersions: app.runtime_versions, root: app.root_path, entries })
  } catch (error) { return jsonError(error) }
}

export async function POST(request: Request, context: Context) {
  let release: (() => Promise<void>) | undefined
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    const body = await request.json()
    const invalid = validateConsoleCommand(body?.command)
    if (invalid) throw new ApiError(invalid, 400)
    const command = body.command.trim() as string
    const id = (await context.params).id
    const app = await project(id)
    if (!existsSync(app.root_path)) throw new ApiError('Prepare the repository in Setup first', 409)
    let workingDirectory: string
    try { workingDirectory = await resolveConsoleWorkingDirectory(app.root_path, body?.cwd) }
    catch (error) { throw new ApiError((error as Error).message, 400) }
    const cd = command.match(/^cd(?:\s+\/d)?(?:\s+(.*))?$/i)
    if (cd) {
      const rawTarget = cd[1]?.trim().replace(/^("|')(.*)\1$/, '$2')
      try { workingDirectory = await resolveConsoleWorkingDirectory(app.root_path, rawTarget ? path.resolve(workingDirectory, rawTarget) : workingDirectory) }
      catch (error) { throw new ApiError((error as Error).message, 400) }
      return new Response(`Directory changed to ${workingDirectory}\n`, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Console-Cwd': encodeURIComponent(workingDirectory) } })
    }
    release = await acquireProjectOperation(id)
    const git = await prepareConsoleGit(command, { root_path: app.root_path, repo_url: app.repo_url, github_connection_id: app.github_connection_id })
    const env = git ? git.env : { ...await readProjectEnvironment(app.root_path, app.project_type), ...await getProjectDatabaseEnv(id), ...await getProjectDataServiceEnv(id), ...projectRuntimeEnvironment(app.runtime_versions), PORT: String(app.port), APP_PORT: String(app.port), FORCE_COLOR: '0', NO_COLOR: '1', NODE_ENV: 'development' }
    await query(`insert into audit_logs(user_id,action,resource,details) values($1,'project.console',$2,$3)`, [user?.id, `project:${id}`, JSON.stringify({ executable: command.split(/\s+/)[0] })])
    const abort = new AbortController()
    const onAbort = () => abort.abort()
    request.signal.addEventListener('abort', onAbort, { once: true })
    if (request.signal.aborted) abort.abort()
    const encoder = new TextEncoder()
    const unlock = release
    release = undefined
    const stream = new ReadableStream({
      start(controller) {
        const write = (text: string) => { try { controller.enqueue(encoder.encode(text)) } catch { /* Client disconnected. */ } }
        if (git?.authenticated) write('[git] Using the application’s saved GitHub connection\n')
        void runCommand(git?.command || prepareConsoleCommand(command), workingDirectory, 900000, write, env, false, { signal: abort.signal, heartbeatMs: 30000, redact: git?.secrets })
          .then(result => {
            if (git && result.code !== 0) write(consoleGitFailureHint(result.output))
            write(`\n[exit] Command finished with code ${result.code}\n`)
          })
          .catch(() => write('\n[error] Could not run command\n'))
          .finally(async () => {
            request.signal.removeEventListener('abort', onAbort)
            await unlock()
            try { controller.close() } catch { /* Client disconnected. */ }
          })
      },
      cancel() { abort.abort() },
    })
    return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no', 'X-Console-Cwd': encodeURIComponent(workingDirectory) } })
  } catch (error) { return jsonError(error) }
  finally { await release?.() }
}
