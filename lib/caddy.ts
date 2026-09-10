import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { runCommand } from './exec'

const CADDY_ROOT = process.env.CADDY_PATH || 'c:\\web'
const CADDYFILE_PATH = process.env.CADDYFILE_PATH || path.join(CADDY_ROOT, 'Caddyfile')
const CADDY_EXE = process.env.CADDY_EXE || path.join(CADDY_ROOT, 'caddy.exe')

interface CaddyProxyRoute {
    matcher: string
    paths: string[]
    port: number
    stripPrefix?: string
    forwardAuth?: { upstream: string; uri: string }
}

const STATIC_APP_PROXY_ROUTES: Record<string, CaddyProxyRoute[]> = {
    'synergyos.smartcloudgh.com': [
        {
            matcher: 'chat',
            paths: ['/connection/websocket', '/connection/websocket/*'],
            port: 8000,
        },
    ],
}

function appProxyRoutes(domain: string): CaddyProxyRoute[] {
    const routes = [...(STATIC_APP_PROXY_ROUTES[domain] || [])]
    const managerDomain = process.env.MANAGER_DOMAIN || 'deploy.smartcloudgh.com'
    const managerPort = Number(process.env.MANAGER_PORT || 4000)
    if (domain === managerDomain) {
        routes.push({
            matcher: 'databaseClient',
            paths: ['/postgres', '/postgres/*'],
            port: Number(process.env.PGWEB_PORT || 8432),
            forwardAuth: { upstream: '127.0.0.1:' + managerPort, uri: '/api/auth/proxy' },
        })
        routes.push({
            matcher: 'mysqlClient',
            paths: ['/mysql', '/mysql/*'],
            port: Number(process.env.PHPMYADMIN_PORT || 8433),
            stripPrefix: '/mysql',
            forwardAuth: { upstream: '127.0.0.1:' + managerPort, uri: '/api/auth/proxy' },
        })
    }
    return routes
}

function sanitizeDomain(domain: string) {
    const value = domain.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/\.$/, '')
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value)) {
        throw new Error('Invalid public domain name')
    }
    return value
}

function renderReverseProxy(port: number, indent = '\t') {
    return `${indent}reverse_proxy 127.0.0.1:${port} {
${indent}\theader_up Host {host}
${indent}\theader_up X-Real-IP {remote}
${indent}\theader_up X-Forwarded-Proto {scheme}
${indent}}`
}

function renderProxyRoute(route: CaddyProxyRoute) {
    const lines = [
        `\t@${route.matcher} path ${route.paths.join(' ')}`,
        '',
        `\thandle @${route.matcher} {`,
    ]

    if (route.forwardAuth) {
        lines.push(
            `\t\tforward_auth ${route.forwardAuth.upstream} {`,
            `\t\t\turi ${route.forwardAuth.uri}`,
            '\t\t}',
            '',
        )
    }
    if (route.stripPrefix) {
        lines.push(`\t\turi strip_prefix ${route.stripPrefix}`, '')
    }
    lines.push(renderReverseProxy(route.port, '\t\t'), '\t}')
    return lines.join('\n')
}

function renderCaddyBlock(domain: string, port: number) {
    const logFile = `C:\\Caddy\\logs\\${domain.replace(/\./g, '-')}-error.log`
    const routes = appProxyRoutes(domain)
    const proxyBlock = routes.length
        ? `${routes.map(renderProxyRoute).join('\n\n')}

\thandle {
${renderReverseProxy(port, '\t\t')}
\t}`
        : renderReverseProxy(port)

    return `# ${domain}
${domain} {
${proxyBlock}

\tlog {
\t\toutput file ${logFile} {
\t\t\troll_size 10MB
\t\t\troll_keep 5
\t\t}
\t\tformat console
\t\tlevel ERROR
\t}
}`
}

function replaceCaddyBlock(content: string, domain: string, newBlock: string) {
    const startMarker = `${domain} {`
    if (!content.includes(startMarker)) {
        return [content.trimEnd(), newBlock.trim()].filter(Boolean).join('\n\n') + '\n'
    }

    const startIndex = content.indexOf(startMarker)
    let openBraces = 0
    let endIndex = -1

    for (let i = startIndex; i < content.length; i++) {
        if (content[i] === '{') openBraces++
        if (content[i] === '}') {
            openBraces--
            if (openBraces === 0) {
                endIndex = i
                break
            }
        }
    }

    if (endIndex === -1) {
        return [content.trimEnd(), newBlock.trim()].filter(Boolean).join('\n\n') + '\n'
    }

    let removeStart = startIndex
    const lines = content.substring(0, startIndex).split('\n')
    const lastLine = lines[lines.length - 2]
    if (lastLine && lastLine.trim().startsWith(`# ${domain}`)) {
        removeStart = content.lastIndexOf(`# ${domain}`, startIndex)
    }

    const before = content.substring(0, removeStart).trimEnd()
    const after = content.substring(endIndex + 1).trimStart()
    return [before, newBlock.trim(), after].filter(Boolean).join('\n\n').trimEnd() + '\n'
}

async function validateCaddyContent(content: string) {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'caddy-'))
    const tempCaddyfile = path.join(tempDir, 'Caddyfile')

    try {
        await writeFile(tempCaddyfile, content, 'utf8')
        const result = await runCommand(`"${CADDY_EXE}" validate --config "${tempCaddyfile}" --adapter caddyfile`, process.cwd())
        if (result.code !== 0) {
            throw new Error(result.output)
        }
        return result.output
    } finally {
        await rm(tempDir, { recursive: true, force: true })
    }
}

async function applyCaddyUpdate(domain: string, port: number) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid application port')
    let content = await readFile(CADDYFILE_PATH, 'utf8')
    const sanitizedDomain = sanitizeDomain(domain)
    content = replaceCaddyBlock(content, sanitizedDomain, renderCaddyBlock(sanitizedDomain, port))

    await validateCaddyContent(content)
    await writeFile(CADDYFILE_PATH, content, 'utf8')

    const validation = await runCommand(`"${CADDY_EXE}" validate --config "${CADDYFILE_PATH}" --adapter caddyfile`, process.cwd())
    if (validation.code !== 0) throw new Error(validation.output)
    const reload = await runCommand(`"${CADDY_EXE}" reload --config "${CADDYFILE_PATH}" --adapter caddyfile`, process.cwd())
    if (reload.code !== 0) throw new Error(reload.output)
    return { domain: sanitizedDomain, validation: validation.output, reload: reload.output }
}

export async function updateCaddyStrict(domain: string, port: number) {
    return applyCaddyUpdate(domain, port)
}

export async function updateCaddyDomainsStrict(domains: string[], port: number) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid application port')
    const sanitized = [...new Set(domains.map(sanitizeDomain))]
    if (!sanitized.length) return { domains: [], validation: '', reload: '' }
    let content = await readFile(CADDYFILE_PATH, 'utf8')
    for (const domain of sanitized) content = replaceCaddyBlock(content, domain, renderCaddyBlock(domain, port))
    await validateCaddyContent(content)
    await writeFile(CADDYFILE_PATH, content, 'utf8')
    const validation = await runCommand(`"${CADDY_EXE}" validate --config "${CADDYFILE_PATH}" --adapter caddyfile`, process.cwd())
    if (validation.code !== 0) throw new Error(validation.output)
    const reload = await runCommand(`"${CADDY_EXE}" reload --config "${CADDYFILE_PATH}" --adapter caddyfile`, process.cwd())
    if (reload.code !== 0) throw new Error(reload.output)
    return { domains: sanitized, validation: validation.output, reload: reload.output }
}

export async function updateCaddy(domain: string, port: number) {
    try {
        return await applyCaddyUpdate(domain, port)
    } catch (error) {
        console.error('Failed to update Caddy:', error)
    }
}

async function applyCaddyRemove(domain: string) {
    let content = await readFile(CADDYFILE_PATH, 'utf8')
    const sanitizedDomain = sanitizeDomain(domain)
    const startMarker = `${sanitizedDomain} {`
    if (!content.includes(startMarker)) return { domain: sanitizedDomain, removed: false }

    const startIndex = content.indexOf(startMarker)
    let openBraces = 0
    let endIndex = -1
    for (let i = startIndex; i < content.length; i++) {
        if (content[i] === '{') openBraces++
        if (content[i] === '}') {
            openBraces--
            if (openBraces === 0) { endIndex = i; break }
        }
    }
    if (endIndex === -1) throw new Error(`Unable to locate the end of the Caddy block for ${sanitizedDomain}`)

    let removeStart = startIndex
    const lines = content.substring(0, startIndex).split('\n')
    const lastLine = lines[lines.length - 2]
    if (lastLine && lastLine.trim().startsWith(`# ${sanitizedDomain}`)) {
        removeStart = content.lastIndexOf(`# ${sanitizedDomain}`, startIndex)
    }
    content = (content.substring(0, removeStart) + content.substring(endIndex + 1)).replace(/\n{3,}/g, '\n\n')

    await validateCaddyContent(content)
    await writeFile(CADDYFILE_PATH, content, 'utf8')
    const validation = await runCommand(`"${CADDY_EXE}" validate --config "${CADDYFILE_PATH}" --adapter caddyfile`, process.cwd())
    if (validation.code !== 0) throw new Error(validation.output)
    const reload = await runCommand(`"${CADDY_EXE}" reload --config "${CADDYFILE_PATH}" --adapter caddyfile`, process.cwd())
    if (reload.code !== 0) throw new Error(reload.output)
    return { domain: sanitizedDomain, removed: true, validation: validation.output }
}

export async function removeFromCaddyStrict(domain: string) {
    return applyCaddyRemove(domain)
}

export async function removeFromCaddy(domain: string) {
    try {
        return await applyCaddyRemove(domain)
    } catch (error) {
        console.error('Failed to remove from Caddy:', error)
    }
}
