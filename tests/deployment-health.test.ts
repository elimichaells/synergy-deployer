import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { waitForDeploymentHealth } from '../lib/deployment-health'
import { getProjectPortEnvironment } from '../lib/project-types'

function fakeClock(statuses: number[] = [503], requestMs = 100) {
  let elapsed = 0
  let calls = 0
  return {
    elapsed: () => elapsed,
    calls: () => calls,
    dependencies: {
      now: () => elapsed,
      sleep: async (milliseconds: number) => { elapsed += milliseconds },
      fetch: (async () => {
        elapsed += requestMs
        return new Response(null, { status: statuses[Math.min(calls++, statuses.length - 1)] })
      }) as typeof fetch,
    },
  }
}

test('Go receives the assigned port in both variables, overriding stale application values', () => {
  assert.deepEqual({ PORT: '8080', APP_PORT: '8080', ...getProjectPortEnvironment('go', 3010) }, {
    PORT: '3010', APP_PORT: '3010',
  })
  assert.deepEqual(getProjectPortEnvironment('go', 4012), { PORT: '4012', APP_PORT: '4012' })
})

test('other frameworks retain their existing PORT behavior', () => {
  for (const type of ['next', 'angular', 'laravel', 'node', undefined]) {
    assert.deepEqual(getProjectPortEnvironment(type, 3006), { PORT: '3006' })
  }
  assert.deepEqual(getProjectPortEnvironment('go', null), {})
})

test('startup retries report progress and stop on a healthy response', async () => {
  const clock = fakeClock([503, 200])
  const messages: string[] = []
  const result = await waitForDeploymentHealth(3010, { onProgress: message => { messages.push(message) } }, clock.dependencies)
  assert.equal(result.healthy, true)
  assert.equal(clock.calls(), 2)
  assert.match(messages[0], /HTTP 503; \d+s remaining/)
})

test('404 and navigation redirects are acceptable without following external redirects', async () => {
  for (const status of [404, 301, 302, 303, 307, 308]) {
    const clock = fakeClock([status])
    const result = await waitForDeploymentHealth(3010, {}, {
      ...clock.dependencies,
      fetch: (async (url, init) => {
        assert.equal(url, 'http://127.0.0.1:3010')
        assert.equal(init?.redirect, 'manual')
        return clock.dependencies.fetch(url, init)
      }) as typeof fetch,
    })
    assert.equal(result.healthy, true)
  }
})

test('a real Next-style login redirect passes without requesting the destination', async () => {
  const paths: string[] = []
  const server = createServer((request, response) => {
    paths.push(request.url || '')
    response.writeHead(request.url === '/' ? 307 : 500, { Location: '/login' })
    response.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const result = await waitForDeploymentHealth(address.port, { timeoutMs: 2000 })
    assert.equal(result.healthy, true)
    assert.deepEqual(paths, ['/'])
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('non-navigation 3xx responses and HTTP errors do not pass health checks', async () => {
  for (const status of [300, 304, 305, 400, 401, 403, 429, 500, 503]) {
    const clock = fakeClock([status])
    const result = await waitForDeploymentHealth(3010, { timeoutMs: 500 }, clock.dependencies)
    assert.equal(result.healthy, false, `HTTP ${status}`)
    assert.match(result.reason!, new RegExp(`HTTP ${status}`))
  }
})

test('request and retry time count against one deadline', async () => {
  const clock = fakeClock([503], 4000)
  const result = await waitForDeploymentHealth(3010, { timeoutMs: 60_000 }, clock.dependencies)
  assert.equal(result.healthy, false)
  assert.equal(clock.elapsed(), 60_000)
  assert.equal(clock.calls(), 10)
  assert.match(result.reason!, /timed out after 60s on port 3010/)
})

test('a crashed, stopped, or missing process fails immediately', async () => {
  for (const status of ['errored', 'stopped', 'missing']) {
    const clock = fakeClock()
    const result = await waitForDeploymentHealth(3010, { checkProcess: async () => status }, clock.dependencies)
    assert.equal(result.healthy, false)
    assert.match(result.reason!, new RegExp(`process is ${status}`))
    assert.equal(clock.calls(), 0)
  }
})

test('temporarily unavailable PM2 status does not fail an otherwise healthy application', async () => {
  const clock = fakeClock([200])
  const result = await waitForDeploymentHealth(3010, { checkProcess: async () => undefined }, clock.dependencies)
  assert.equal(result.healthy, true)
})

test('cancellation interrupts health checks', async () => {
  const clock = fakeClock()
  await assert.rejects(waitForDeploymentHealth(3010, {
    checkCancelled: () => { throw new Error('Deployment cancelled by user') },
  }, clock.dependencies), /Deployment cancelled by user/)
  assert.equal(clock.calls(), 0)
})

test('a hanging HTTP request is aborted within the total deadline', async () => {
  const server = createServer(() => {})
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const started = performance.now()
    const result = await waitForDeploymentHealth(address.port, { timeoutMs: 150, requestTimeoutMs: 5000 })
    assert.equal(result.healthy, false)
    assert.ok(performance.now() - started < 1500)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
