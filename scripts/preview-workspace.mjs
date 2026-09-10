import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-workspace-preview-'))
// Only UI source and pure shared types are copied. No .env, middleware,
// instrumentation, production APIs, schedulers or server libraries are included.
const entries = ['app/sites', 'app/automation', 'app/domains', 'app/settings', 'app/data-services', 'app/layout.tsx', 'app/globals.css', 'components', 'lib/utils.ts', 'lib/project-types.ts', 'lib/project-setup-policy.ts', 'lib/settings-workspace.ts', 'lib/data-removal-policy.ts', 'next.config.js', 'postcss.config.js', 'tailwind.config.js', 'tsconfig.json', 'package.json']
for (const entry of entries) {
  const dest = path.join(root, entry)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(path.join(source, entry), dest, { recursive: true })
}
fs.mkdirSync(path.join(root, 'app/api/[[...path]]'), { recursive: true })
fs.copyFileSync(path.join(source, 'tests/fixtures/workspace-api.ts'), path.join(root, 'app/api/[[...path]]/route.ts'))
fs.mkdirSync(path.join(root, 'app/preview-viewports'), { recursive: true })
fs.copyFileSync(path.join(source, 'tests/fixtures/workspace-viewports.tsx'), path.join(root, 'app/preview-viewports/page.tsx'))
fs.symlinkSync(path.join(source, 'node_modules'), path.join(root, 'node_modules'), 'junction')
console.log(root)
