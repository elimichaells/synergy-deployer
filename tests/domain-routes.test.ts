import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeRoutePrefix, orderRoutes, stackRouteProblem } from '../lib/domain-route-policy'
import { renderCaddyBlock } from '../lib/caddy'

test('route prefixes are normalized and unsafe paths rejected', () => {
  assert.equal(normalizeRoutePrefix('api'), '/api')
  assert.equal(normalizeRoutePrefix('/API/v2/'), '/api/v2')
  assert.equal(normalizeRoutePrefix('/api/*'), '/api')
  for (const bad of ['', '/', '/../etc', '/api space', '/.well-known/acme-challenge', '/a{b}']) {
    assert.throws(() => normalizeRoutePrefix(bad), Error, bad)
  }
})

test('only same-stack, same-environment applications with a port can share a domain', () => {
  const base = { domainProjectId: 'web', domainGroupId: 'g', domainEnvironment: 'production', targetProjectId: 'api', targetGroupId: 'g', targetEnvironment: 'production', targetPort: 3100 }
  assert.equal(stackRouteProblem(base), null)
  assert.match(stackRouteProblem({ ...base, targetGroupId: 'other' })!, /same stack/)
  assert.match(stackRouteProblem({ ...base, domainGroupId: null, targetGroupId: null })!, /same stack/)
  assert.match(stackRouteProblem({ ...base, targetEnvironment: 'staging' })!, /staging/)
  assert.match(stackRouteProblem({ ...base, targetPort: null })!, /port/)
  assert.match(stackRouteProblem({ ...base, targetProjectId: 'web' })!, /already serves/)
})

test('longer prefixes are matched first', () => {
  assert.deepEqual(orderRoutes([{ path_prefix: '/api' }, { path_prefix: '/api/v2' }, { path_prefix: '/ws' }]).map(route => route.path_prefix), ['/api/v2', '/api', '/ws'])
})

test('Caddy routes stack paths before falling back to the domain owner', () => {
  const block = renderCaddyBlock('app.example.test', 3100, [
    { path_prefix: '/api', port: 3200, strip_prefix: true },
    { path_prefix: '/api/admin', port: 3300, strip_prefix: false },
  ])
  const admin = block.indexOf('@stack0 path /api/admin /api/admin/*')
  const api = block.indexOf('@stack1 path /api /api/*')
  assert.ok(admin > 0 && api > admin, block)
  assert.match(block, /handle @stack1 \{\n\t\turi strip_prefix \/api\n\n\t\treverse_proxy 127\.0\.0\.1:3200/)
  assert.doesNotMatch(block.slice(block.indexOf('handle @stack0'), api), /strip_prefix/)
  assert.match(block, /\thandle \{\n\t\treverse_proxy 127\.0\.0\.1:3100/)
})

test('domains without stack routes keep the plain reverse proxy', () => {
  const block = renderCaddyBlock('plain.example.test', 3100)
  assert.doesNotMatch(block, /handle/)
  assert.match(block, /^\treverse_proxy 127\.0\.0\.1:3100 \{/m)
})
