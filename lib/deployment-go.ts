import path from 'node:path'
import type { CommandResult } from './exec'

// The Go tool resolves build tags and packages; do not guess entrypoints from filenames.
export async function detectGoBuildCommand(
  rootPath: string,
  execute: (command: string) => Promise<CommandResult>,
  append: (message: string) => void | Promise<void>
) {
  const result = await execute('go list -f "{{.Name}}|{{.ImportPath}}|{{.Dir}}" ./...')
  if (result.code !== 0) throw new Error('Could not inspect Go packages; fix the go list error or configure a build command')
  const candidates = result.output.split(/\r?\n/).map(line => line.trim().split('|'))
    .filter(fields => fields.length === 3 && fields[0] === 'main')
  const root = candidates.find(([, , dir]) => path.resolve(dir) === path.resolve(rootPath))
  const selected = root ?? (candidates.length === 1 ? candidates[0] : undefined)
  if (!selected) {
    throw new Error(candidates.length ? 'Multiple Go main packages found; configure the build command for the intended application' : 'No buildable Go main package found; configure the build command')
  }
  const relative = path.relative(rootPath, selected[2]).split(path.sep).join('/')
  const target = relative ? `./${relative}` : '.'
  if (!/^\.(\/[a-zA-Z0-9_.-]+)*$/.test(target) || relative.split('/').includes('..')) {
    throw new Error('Go entrypoint requires an explicit build command')
  }
  await append(`[prepare] Go entrypoint: ${target}\n`)
  return `go build -o app.exe ${target}`
}
