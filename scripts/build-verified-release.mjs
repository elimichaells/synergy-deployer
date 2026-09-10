import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-workspace-release-'))
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
const inputs = []
for (const file of new Set(files)) {
  // A verified build needs source, not previous builds, installer binaries or
  // machine-specific secrets that may exist among untracked workspace files.
  if (/(^|\/)\.next[^/]*(\/|$)/.test(file) || /^(packages|node_modules|installer\/ManagerSetup\/(Assets|bin|obj))\//.test(file)) continue
  if (/(^|\/)\.env($|\.)/.test(file) && !file.endsWith('.example')) continue
  const from = path.resolve(root, file)
  if (!from.startsWith(root + path.sep) || !fs.existsSync(from) || !fs.statSync(from).isFile()) continue
  const to = path.join(stage, file)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  inputs.push({ file, hash: crypto.createHash('sha256').update(fs.readFileSync(from)).digest('hex') })
}
fs.symlinkSync(path.join(root, 'node_modules'), path.join(stage, 'node_modules'), 'junction')
fs.writeFileSync(path.join(stage, 'release-inputs.json'), JSON.stringify(inputs, null, 2))
const require = createRequire(import.meta.url)
require('@next/env').loadEnvConfig(root, false, { info() {}, error() {} })
console.log(`Release candidate: ${stage}`)
const child = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'build'], { cwd: stage, env: { ...process.env, NODE_ENV: 'production' }, windowsHide: true, stdio: 'inherit' })
child.on('exit', code => { console.log(`Build exit code: ${code}; candidate: ${stage}`); process.exitCode = code ?? 1 })
