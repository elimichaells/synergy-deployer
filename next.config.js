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
    '/api/servers/**/*': ['./scripts/manager-agent.cjs', './scripts/bootstrap-remote-agent.*', './db/migrations/025_managed_servers.sql', './db/migrations/026_remote_app_setup.sql'],
    '/api/server-agent/*': ['./db/migrations/025_managed_servers.sql', './db/migrations/026_remote_app_setup.sql'],
  },
  env: { NEXT_PUBLIC_MANAGER_VERSION: version, NEXT_PUBLIC_MANAGER_COMMIT: sourceCommit },
}

module.exports = nextConfig
