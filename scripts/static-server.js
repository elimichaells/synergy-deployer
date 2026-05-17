const fs = require('fs')
const http = require('http')
const path = require('path')

const rootPath = process.env.MANAGER_APP_CWD || process.cwd()
const configuredDir = process.env.MANAGER_STATIC_DIR
const port = Number(process.env.PORT || process.env.MANAGER_PORT || 3000)
const host = process.env.HOSTNAME || '127.0.0.1'

function findStaticRoot() {
  if (configuredDir) {
    return path.isAbsolute(configuredDir) ? configuredDir : path.join(rootPath, configuredDir)
  }

  const distPath = path.join(rootPath, 'dist')
  if (!fs.existsSync(distPath)) return rootPath

  const browserDirs = []
  const stack = [distPath]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (!entry.isDirectory()) continue
      if (entry.name === 'browser' && fs.existsSync(path.join(fullPath, 'index.html'))) {
        browserDirs.push(fullPath)
      }
      stack.push(fullPath)
    }
  }
  if (browserDirs[0]) return browserDirs[0]

  const directApps = fs.readdirSync(distPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(distPath, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'index.html')))

  return directApps[0] || distPath
}

const staticRoot = findStaticRoot()
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    res.writeHead(200, {
      'Content-Type': contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    })
    res.end(data)
  })
}

http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const requestedPath = decodeURIComponent(url.pathname)
  const normalizedPath = path.normalize(requestedPath).replace(/^([/\\])+/, '')
  const filePath = path.join(staticRoot, normalizedPath)

  if (!filePath.startsWith(staticRoot)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  fs.stat(filePath, (error, stats) => {
    if (!error && stats.isFile()) {
      sendFile(res, filePath)
      return
    }
    if (!error && stats.isDirectory()) {
      const indexPath = path.join(filePath, 'index.html')
      if (fs.existsSync(indexPath)) {
        sendFile(res, indexPath)
        return
      }
    }
    sendFile(res, path.join(staticRoot, 'index.html'))
  })
}).listen(port, host, () => {
  console.log(`Static server listening on http://${host}:${port}`)
  console.log(`Serving ${staticRoot}`)
})
