import net from 'net'
import { query } from '@/lib/db'

const DEFAULT_START = 3000
const DEFAULT_END = 9999
const RESERVED_PORTS = new Set([Number(process.env.MANAGER_PORT || 4000), 5432, 80, 443])

function canListen(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

export async function allocateTemporaryPort(start = 10_000, end = 20_000) {
  const { rows } = await query<{ port: number | null }>('select port from projects where port is not null')
  const used = new Set(rows.map(row => row.port).filter((port): port is number => typeof port === 'number'))
  for (const reserved of RESERVED_PORTS) used.add(reserved)
  for (let port = start; port <= end; port++) {
    if (!used.has(port) && await canListen(port)) return port
  }
  throw new Error(`No temporary deployment port is available between ${start} and ${end}`)
}

export async function allocateProjectPorts(start = DEFAULT_START, end = DEFAULT_END, includeStaging = true) {
  const { rows } = await query<{ port: number | null }>('select port from projects where port is not null')
  const used = new Set(rows.map((row) => row.port).filter((port): port is number => typeof port === 'number'))
  for (const reserved of RESERVED_PORTS) used.add(reserved)

  for (let port = start; port <= (includeStaging ? end - 1000 : end); port++) {
    const stagingPort = port + 1000
    if (used.has(port) || (includeStaging && used.has(stagingPort))) continue
    if (includeStaging && RESERVED_PORTS.has(stagingPort)) continue
    const [productionAvailable, stagingAvailable] = await Promise.all([
      canListen(port),
      includeStaging ? canListen(stagingPort) : Promise.resolve(true),
    ])
    if (productionAvailable && stagingAvailable) {
      return { port, stagingPort }
    }
  }

  throw new Error(`No available production/staging port pair found between ${start} and ${end}`)
}
