import assert from 'node:assert/strict'
import test from 'node:test'
import { runCommand } from '../lib/exec'
import { DEPLOYMENT_COMMAND_TIMEOUT_MS, runDeploymentCommand } from '../lib/deployment-command'

const node = (script: string) => `"${process.execPath}" -e "${script}"`

test('deployment commands get a bounded fifteen minute budget and stream output once', async () => {
  assert.equal(DEPLOYMENT_COMMAND_TIMEOUT_MS, 900_000)
  const chunks: string[] = []
  const result = await runDeploymentCommand(node("console.log('completed')"), process.cwd(), {}, s => chunks.push(s), () => {})
  assert.equal(result.code, 0)
  assert.match(chunks.join(''), /Time limit: 15 minutes/)
  assert.equal(chunks.join('').match(/completed/g)?.length, 1)
})

test('quiet commands report progress and do not keep reporting after exit', async () => {
  const chunks: string[] = []
  const result = await runCommand(node('setTimeout(()=>process.exit(0),200)'), undefined, 5000,
    s => chunks.push(s), undefined, true, { heartbeatMs: 50 })
  assert.equal(result.code, 0)
  assert.match(chunks.join(''), /still running.*limit 5s/)
  const count = chunks.length
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(chunks.length, count)
})

test('timeout kills a running process and reports failure once', async () => {
  const result = await runCommand(node('setInterval(()=>{},1000)'), undefined, 100)
  assert.equal(result.code, 1)
  assert.equal(result.output.match(/\[timeout\]/g)?.length, 1)
})

test('an already cancelled command is never started', async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await runCommand(node("console.log('should-not-run')"), undefined, 5000, undefined, undefined, true, { signal: controller.signal })
  assert.equal(result.code, 1)
  assert.doesNotMatch(result.output, /should-not-run/)
  assert.match(result.output, /not started/)
})

test('cancelling a deployment interrupts its command, not just the next step', async () => {
  let cancelled = false
  const chunks: string[] = []
  const cancel = setTimeout(() => { cancelled = true }, 100)
  try {
    await assert.rejects(runDeploymentCommand(node('setInterval(()=>{},1000)'), process.cwd(), {}, s => chunks.push(s), () => {
      if (cancelled) throw new Error('Deployment cancelled by user')
    }), /Deployment cancelled by user/)
    assert.match(chunks.join(''), /Command process tree stopped/)
    assert.doesNotMatch(chunks.join(''), /\[timeout\]/)
  } finally {
    clearTimeout(cancel)
  }
})

test('command exit failures are preserved', async () => {
  const result = await runDeploymentCommand(node('process.exit(7)'), process.cwd(), {}, () => {}, () => {})
  assert.equal(result.code, 7)
})
