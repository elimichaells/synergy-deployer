import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { runCommand } from './exec'

const CADDYFILE_PATH = 'c:\\web\\Caddyfile'
const CADDY_EXE = 'c:\\web\\caddy.exe'

interface CaddyProxyRoute {
    matcher: string
    paths: string[]
    port: number
    forwardAuth?: { upstream: string; uri: string }
}

const APP_PROXY_ROUTES: Record<string, CaddyProxyRoute[]> = {
    'synergyos.smartcloudgh.com': [
        {
            matcher: 'chat',
            paths: ['/connection/websocket', '/connection/websocket/*'],
            port: 8000,
        },
    ],
    'deploy.smartcloudgh.com': [
        {
            matcher: 'databaseClient',
            paths: ['/postgres', '/postgres/*'],
            port: 8432,
            forwardAuth: { upstream: '127.0.0.1:4000', uri: '/api/auth/proxy' },
        },
    ],
}

function sanitizeDomain(domain: string) {
    return domain.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

function renderReverseProxy(port: number, indent = '\t') {
    return `${indent}reverse_proxy 127.0.0.1:${port} {
${indent}\theader_up Host {host}
${indent}\theader_up X-Real-IP {remote}
${indent}\theader_up X-Forwarded-Proto {scheme}
${indent}}`
}

function renderCaddyBlock(domain: string, port: number) {
    const logFile = `C:\\Caddy\\logs\\${domain.replace(/\./g, '-')}-error.log`
    const routes = APP_PROXY_ROUTES[domain] || []
    const proxyBlock = routes.length
        ? `${routes.map((route) => `\t@${route.matcher} path ${route.paths.join(' ')}

\thandle @${route.matcher} {
${route.forwardAuth ? `\t\tforward_auth ${route.forwardAuth.upstream} {
\t\t\turi ${route.forwardAuth.uri}
\t\t}

` : ''}
${renderReverseProxy(route.port, '\t\t')}
\t}`).join('\n\n')}

\thandle {
${renderReverseProxy(port, '\t\t')}
\t}`
        : renderReverseProxy(port)

    return `
# ${domain}
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
}
`
}

function replaceCaddyBlock(content: string, domain: string, newBlock: string) {
    const startMarker = `${domain} {`
    if (!content.includes(startMarker)) {
        return content + newBlock
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
        return content + newBlock
    }

    let removeStart = startIndex
    const lines = content.substring(0, startIndex).split('\n')
    const lastLine = lines[lines.length - 2]
    if (lastLine && lastLine.trim().startsWith(`# ${domain}`)) {
        removeStart = content.lastIndexOf(`# ${domain}`, startIndex)
    }

    const before = content.substring(0, removeStart)
    const after = content.substring(endIndex + 1)
    return before + newBlock + after
}

async function validateCaddyContent(content: string) {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'caddy-'))
    const tempCaddyfile = path.join(tempDir, 'Caddyfile')

    try {
        await writeFile(tempCaddyfile, content, 'utf8')
        const result = await runCommand(`"${CADDY_EXE}" validate --config "${tempCaddyfile}" --adapter caddyfile`, 'c:\\web\\manager')
        if (result.code !== 0) {
            throw new Error(result.output)
        }
        return result.output
    } finally {
        await rm(tempDir, { recursive: true, force: true })
    }
}

export async function updateCaddy(domain: string, port: number) {
    try {
        // 1. Read Caddyfile
        let content = await readFile(CADDYFILE_PATH, 'utf8')

        // 2. Prepare the block
        const sanitizedDomain = sanitizeDomain(domain)
        // Skip localhost
        if (sanitizedDomain.includes('localhost') || sanitizedDomain.includes('127.0.0.1')) {
            return
        }

        const newBlock = renderCaddyBlock(sanitizedDomain, port)

        // 3. Replace only this app's block, leaving all other Caddy sites intact.
        content = replaceCaddyBlock(content, sanitizedDomain, newBlock)

        await validateCaddyContent(content)

        // 4. Write back
        await writeFile(CADDYFILE_PATH, content, 'utf8')

        // 5. Validate active file, then reload Caddy
        const validation = await runCommand(`"${CADDY_EXE}" validate --config "${CADDYFILE_PATH}" --adapter caddyfile`, 'c:\\web\\manager')
        if (validation.code !== 0) {
            throw new Error(validation.output)
        }

        const reload = await runCommand(`"${CADDY_EXE}" reload --config "${CADDYFILE_PATH}" --adapter caddyfile`, 'c:\\web\\manager')
        if (reload.code !== 0) {
            throw new Error(reload.output)
        }

    } catch (error) {
        console.error('Failed to update Caddy:', error)
        // Don't throw, just log. We don't want to break the API response if Caddy fails.
    }
}

export async function removeFromCaddy(domain: string) {
    try {
        let content = await readFile(CADDYFILE_PATH, 'utf8')
        const sanitizedDomain = sanitizeDomain(domain)

        const startMarker = `${sanitizedDomain} {`
        if (!content.includes(startMarker)) return

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

        if (endIndex !== -1) {
            let removeStart = startIndex
            const lines = content.substring(0, startIndex).split('\n')
            const lastLine = lines[lines.length - 2]
            if (lastLine && lastLine.trim().startsWith(`# ${sanitizedDomain}`)) {
                removeStart = content.lastIndexOf(`# ${sanitizedDomain}`, startIndex)
            }

            const before = content.substring(0, removeStart)
            const after = content.substring(endIndex + 1)
            // Clean up extra newlines
            content = (before + after).replace(/\n{3,}/g, '\n\n')

            await writeFile(CADDYFILE_PATH, content, 'utf8')
            await runCommand(`${CADDY_EXE} reload --config ${CADDYFILE_PATH}`, 'c:\\web\\manager')
        }
    } catch (error) {
        console.error('Failed to remove from Caddy:', error)
    }
}
