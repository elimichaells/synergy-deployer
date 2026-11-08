const { version } = require('./package.json')
let sourceCommit = ''
try { sourceCommit = require('./release-source.json').sourceCommit || '' } catch { /* Local development has no release receipt. */ }
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: { cpus: 2 },
  serverExternalPackages: ['ssh2'],
  outputFileTracingIncludes: {
    '/api/manager-updates': ['./scripts/manager-update-*.cjs', './scripts/update-trusted-root.json'],
    '/api/servers/**/*': ['./scripts/manager-agent*.cjs', './scripts/bootstrap-remote-agent.*', './scripts/inspect-remote-server.*', './scripts/install-remote-service.*', './scripts/bootstrap-remote-service.sh', './scripts/install-remote-tool.cjs', './scripts/remote-service-policy.cjs', './docs/agent-updates.md', './db/migrations/025_managed_servers.sql', './db/migrations/026_remote_app_setup.sql', './db/migrations/027_remote_agent_updates.sql', './db/migrations/028_remote_operations.sql', './db/migrations/029_remote_infrastructure.sql'],
    '/api/server-agent/*': ['./db/migrations/025_managed_servers.sql', './db/migrations/026_remote_app_setup.sql', './db/migrations/027_remote_agent_updates.sql', './db/migrations/028_remote_operations.sql', './db/migrations/029_remote_infrastructure.sql'],
  },
  env: { NEXT_PUBLIC_MANAGER_VERSION: version, NEXT_PUBLIC_MANAGER_COMMIT: sourceCommit },
}

module.exports = nextConfig
