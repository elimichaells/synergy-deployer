import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { detectGoBuildCommand } from '../lib/deployment-go'

const root = path.resolve('go-project')
const inspect = (output: string, code = 0) => async (command: string) => {
  assert.equal(command, 'go list -f "{{.Name}}|{{.ImportPath}}|{{.Dir}}" ./...')
  return { code, output }
}
const pkg = (name: string, subdir = '') => `${name}|example.com/backend/${subdir}|${path.join(root, subdir)}\n`

test('Go detects cmd/server without changing the working directory or executable name', async () => {
  const messages: string[] = []
  assert.equal(await detectGoBuildCommand(root, inspect(pkg('config', 'internal/config') + pkg('main', 'cmd/server')), s => { messages.push(s) }), 'go build -o app.exe ./cmd/server')
  assert.match(messages.join(''), /Go entrypoint: .\/cmd\/server/)
})

test('a root main package takes precedence over utility commands', async () => {
  assert.equal(await detectGoBuildCommand(root, inspect(pkg('main') + pkg('main', 'cmd/tool')), () => {}), 'go build -o app.exe .')
})

test('ambiguous or missing entrypoints require configuration rather than guessing', async () => {
  await assert.rejects(detectGoBuildCommand(root, inspect(pkg('main', 'cmd/one') + pkg('main', 'cmd/two')), () => {}), /Multiple Go main packages/)
  await assert.rejects(detectGoBuildCommand(root, inspect(pkg('library')), () => {}), /No buildable Go main package/)
})

test('Go inspection failures are not hidden', async () => {
  await assert.rejects(detectGoBuildCommand(root, inspect('module unavailable', 1), () => {}), /Could not inspect Go packages/)
})

test('an entrypoint outside the checkout or with shell metacharacters is refused', async () => {
  await assert.rejects(detectGoBuildCommand(root, inspect(pkg('main', '../outside')), () => {}), /explicit build command/)
  await assert.rejects(detectGoBuildCommand(root, inspect(pkg('main', 'cmd/bad&path')), () => {}), /explicit build command/)
})
