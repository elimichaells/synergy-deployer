const { version } = require('./package.json')
let sourceCommit = ''
try { sourceCommit = require('./release-source.json').sourceCommit || '' } catch { /* Local development has no release receipt. */ }
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: { cpus: 2 },
  serverExternalPackages: ['ssh2'],
  outputFileTracingIncludes: {
    '/*': ['./db/migrations/03*.sql', './scripts/http-health.cjs', './scripts/health-diagnostics.cjs', './scripts/dependency-audit.cjs', './scripts/remote-release-data.cjs'],
    '/api/manager-updates': ['./scripts/manager-update-*.cjs', './scripts/update-trusted-root.json'],
    '/api/servers/**/*': ['./scripts/manager-agent*.cjs', './scripts/agent-bundle.cjs', './scripts/lan-address.cjs', './scripts/lan-listener.cjs', './scripts/tune-database-memory.ps1', './scripts/database-service.ps1', './scripts/bootstrap-remote-agent.*', './scripts/inspect-remote-server.*', './scripts/install-remote-service.*', './scripts/bootstrap-remote-service.sh', './scripts/install-remote-tool.cjs', './scripts/remote-service-policy.cjs', './docs/agent-updates.md', './db/migrations/025_managed_servers.sql', './db/migrations/026_remote_app_setup.sql', './db/migrations/027_remote_agent_updates.sql', './db/migrations/028_remote_operations.sql', './db/migrations/029_remote_infrastructure.sql', './db/migrations/030_remote_resources.sql'],
    '/api/server-agent/*': ['./db/migrations/025_managed_servers.sql', './db/migrations/026_remote_app_setup.sql', './db/migrations/027_remote_agent_updates.sql', './db/migrations/028_remote_operations.sql', './db/migrations/029_remote_infrastructure.sql', './db/migrations/030_remote_resources.sql'],
  },
  env: { NEXT_PUBLIC_MANAGER_VERSION: version, NEXT_PUBLIC_MANAGER_COMMIT: sourceCommit },
}

module.exports = nextConfig
