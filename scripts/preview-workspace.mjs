import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-workspace-preview-'))
// Only UI source and pure shared types are copied. No .env, middleware,
// instrumentation, production APIs, schedulers or server libraries are included.
const entries = ['app/page.tsx', 'app/overview', 'app/projects', 'app/deployments', 'app/storage', 'app/services', 'app/infrastructure/page.tsx', 'app/sites', 'app/automation', 'app/domains', 'app/settings', 'app/data-services', 'app/layout.tsx', 'app/globals.css', 'components', 'lib/utils.ts', 'lib/project-types.ts', 'lib/project-setup-policy.ts', 'lib/settings-workspace.ts', 'lib/data-removal-policy.ts', 'lib/server-navigation.ts', 'lib/workspace-navigation.ts', 'lib/application-environments.ts', 'lib/application-health.ts', 'lib/deployment-stages.ts', 'lib/deployment-watch.ts', 'lib/env-describe.ts', 'lib/format.ts', 'lib/git-provider-policy.ts', 'lib/security-gate-policy.ts', 'lib/server-health-types.ts', 'lib/server-memory-policy.ts', 'lib/staging-sleep-policy.ts', 'lib/ai-operations-policy.ts', 'next.config.js', 'postcss.config.js', 'tailwind.config.js', 'tsconfig.json', 'package.json']
for (const entry of entries) {
  const dest = path.join(root, entry)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(path.join(source, entry), dest, { recursive: true })
}
for (const entry of ['app/infrastructure/memory','app/infrastructure/operations','app/infrastructure/servers', 'app/infrastructure/disk', 'app/infrastructure/health', 'app/infrastructure/runtimes', 'lib/managed-server-types.ts', 'lib/server-tool-catalog.ts', 'lib/remote-service-catalog.ts', 'lib/remote-server-overview.ts', 'lib/remote-setup-policy.ts', 'lib/remote-workspace.ts', 'lib/environment-text.ts']) {
  const dest = path.join(root, entry)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(path.join(source, entry), dest, { recursive: true })
}
fs.mkdirSync(path.join(root, 'app/api/[[...path]]'), { recursive: true })
fs.copyFileSync(path.join(source, 'tests/fixtures/workspace-api.ts'), path.join(root, 'app/api/[[...path]]/route.ts'))
fs.copyFileSync(path.join(source, 'tests/fixtures/remote-servers-api.ts'), path.join(root, 'app/api/[[...path]]/remote-servers-api.ts'))
fs.copyFileSync(path.join(source, 'tests/fixtures/release-cleanup-api.ts'), path.join(root, 'app/api/[[...path]]/release-cleanup-api.ts'))
fs.copyFileSync(path.join(source, 'tests/fixtures/resource-workspaces-api.ts'), path.join(root, 'app/api/[[...path]]/resource-workspaces-api.ts'))
for(const entry of ['lib/storage-client.ts','lib/storage-request-queue.ts','lib/infrastructure-client.ts','lib/application-removal-types.ts','lib/domain-route-policy.ts','lib/lan-address.ts','scripts/lan-address.cjs']) {
  if(!fs.existsSync(path.join(source,entry)))continue
  fs.mkdirSync(path.dirname(path.join(root,entry)),{recursive:true})
  fs.copyFileSync(path.join(source,entry),path.join(root,entry))
}
fs.copyFileSync(path.join(source,'tests/fixtures/storage-api.ts'),path.join(root,'app/api/[[...path]]/storage-api.ts'))
const fixtureFile=path.join(root,'app/api/[[...path]]/route.ts')
fs.writeFileSync(fixtureFile,fs.readFileSync(fixtureFile,'utf8').replace("'../../scripts/lan-address.cjs'","'@/scripts/lan-address.cjs'"))
fs.mkdirSync(path.join(root, 'app/preview-viewports'), { recursive: true })
fs.copyFileSync(path.join(source, 'tests/fixtures/workspace-viewports.tsx'), path.join(root, 'app/preview-viewports/page.tsx'))
fs.symlinkSync(path.join(source, 'node_modules'), path.join(root, 'node_modules'), 'junction')
fs.appendFileSync(path.join(root, 'next.config.js'), "\nmodule.exports.env.NEXT_PUBLIC_WORKSPACE_PREVIEW = '1'\n")
console.log(root)
