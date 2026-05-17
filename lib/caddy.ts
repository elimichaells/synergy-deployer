import { readFile, writeFile } from 'fs/promises'
import path from 'path'
import { runCommand } from './exec'

const CADDYFILE_PATH = 'c:\\web\\Caddyfile'
const CADDY_EXE = 'c:\\web\\caddy.exe'

export async function updateCaddy(domain: string, port: number) {
    try {
        // 1. Read Caddyfile
        let content = await readFile(CADDYFILE_PATH, 'utf8')

        // 2. Prepare the block
        const sanitizedDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '')
        // Skip localhost
        if (sanitizedDomain.includes('localhost') || sanitizedDomain.includes('127.0.0.1')) {
            return
        }

        const logFile = `C:\\Caddy\\logs\\${sanitizedDomain.replace(/\./g, '-')}-error.log`

        const newBlock = `
# ${sanitizedDomain}
${sanitizedDomain} {
	reverse_proxy 127.0.0.1:${port} {
		header_up Host {host}
		header_up X-Real-IP {remote}
	}

	log {
		output file ${logFile} {
			roll_size 10MB
			roll_keep 5
		}
		format console
		level ERROR
	}
}
`

        // 3. Check if domain exists
        // Regex to match: domain { ... }
        // We use a simplified check: search for the domain header
        // This is a basic implementation. Ideally we'd use a Caddyfile parser or Caddy API.
        const startMarker = `${sanitizedDomain} {`

        // If it exists, we likely need to REPLACE it or strictly the port
        // But parsing nested braces with regex is hard.
        // However, our format is consistent.

        if (content.includes(startMarker)) {
            // Find the start index
            const startIndex = content.indexOf(startMarker)
            // Find the blocking ending brace. This assumes balanced braces or standard indentation.
            // Given the standard format, we can look for the next "}" that is at the start of a line (if formatted) 
            // or just scan for balanced braces.

            let openBraces = 0
            let endIndex = -1

            // precise parsing from startIndex
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
                // Remove the old block (including potential preceding comment)
                // Look back for comment line
                let removeStart = startIndex
                const lines = content.substring(0, startIndex).split('\n')
                const lastLine = lines[lines.length - 2] // line before the start line
                if (lastLine && lastLine.trim().startsWith(`# ${sanitizedDomain}`)) {
                    // Adjust removeStart to include the comment
                    removeStart = content.lastIndexOf(`# ${sanitizedDomain}`, startIndex)
                }

                const before = content.substring(0, removeStart)
                const after = content.substring(endIndex + 1)
                content = before + newBlock + after
            } else {
                // Fallback if parsing failed
                content += newBlock
            }
        } else {
            // Append
            content += newBlock
        }

        // 4. Write back
        await writeFile(CADDYFILE_PATH, content, 'utf8')

        // 5. Reload Caddy
        await runCommand(`${CADDY_EXE} reload --config ${CADDYFILE_PATH}`, 'c:\\web\\manager')

    } catch (error) {
        console.error('Failed to update Caddy:', error)
        // Don't throw, just log. We don't want to break the API response if Caddy fails.
    }
}

export async function removeFromCaddy(domain: string) {
    try {
        let content = await readFile(CADDYFILE_PATH, 'utf8')
        const sanitizedDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '')

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
