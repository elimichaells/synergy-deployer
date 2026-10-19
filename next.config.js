const { version } = require('./package.json')
let sourceCommit = ''
try { sourceCommit = require('./release-source.json').sourceCommit || '' } catch { /* Local development has no release receipt. */ }
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: { cpus: 2 },
  env: { NEXT_PUBLIC_MANAGER_VERSION: version, NEXT_PUBLIC_MANAGER_COMMIT: sourceCommit },
}

module.exports = nextConfig
