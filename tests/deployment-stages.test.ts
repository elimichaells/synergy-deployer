import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDeploymentLog, relativeTime, formatSeconds, stagesFromPhase } from '../lib/deployment-stages'

const successLog = [
  '[release] Candidate: C:\\web\\releases\\app\\candidate',
  '[timing] prepare: 2s',
  '[stage] checkout',
  'HEAD is now at a7e9821',
  '[timing] checkout: 1s',
  '[stage] security',
  '[security] Committed dependency audit passed; final candidate will be checked again',
  '[timing] security: 3s',
  '[stage] dependencies',
  'added 120 packages',
  '[timing] dependencies: 20s',
  '[stage] build',
  'Compiled successfully',
  '[timing] build: 40s',
  '[stage] security',
  '[security] Production dependency audit passed: 0 low, 0 moderate, 0 high, 0 critical',
  '[timing] security: 2s',
  '[stage] preflight',
  '[preflight] Candidate boot and HTTP health verified before activation',
  '[stage] activate',
  '[timing] activate: 4s',
  '[stage] health',
  '[health] OK',
  '[release] Active on original port; previous source retained at C:\\old',
  '',
].join('\n')

test('successful logs become ordered sections with per-stage durations', () => {
  const pipeline = parseDeploymentLog(successLog, 'success', 'complete')
  assert.deepEqual(pipeline.sections.map(section => section.label), [
    'Initialize release', 'Checkout source', 'Security gate', 'Install dependencies', 'Build',
    'Final security audit', 'Candidate preflight', 'Activate release', 'Health check',
  ])
  assert.equal(pipeline.stages.find(stage => stage.key === 'security')?.durationSec, 5)
  assert.equal(pipeline.stages.find(stage => stage.key === 'build')?.durationSec, 40)
  assert.ok(pipeline.stages.every(stage => stage.state === 'done'))
  assert.equal(pipeline.progress, 1)
  assert.equal(pipeline.currentLabel, 'Ready')
  assert.equal(pipeline.zeroDowntime, true)
})

test('the first security pass does not mark install and build as skipped', () => {
  const log = successLog.slice(0, successLog.indexOf('[timing] security: 3s'))
  const pipeline = parseDeploymentLog(log, 'running', 'security')
  const state = (key: string) => pipeline.stages.find(stage => stage.key === key)?.state
  assert.equal(state('checkout'), 'done')
  assert.equal(state('security'), 'active')
  assert.equal(state('install'), 'pending')
  assert.equal(state('build'), 'pending')
  assert.equal(pipeline.currentLabel, 'Security…')
})

test('the phase column advances a running pipeline ahead of the flushed log', () => {
  const pipeline = parseDeploymentLog('[stage] checkout\n', 'running', 'dependencies')
  assert.equal(pipeline.stages.find(stage => stage.key === 'checkout')?.state, 'done')
  assert.equal(pipeline.stages.find(stage => stage.key === 'install')?.state, 'active')
})

test('failures mark the stage holding the error and surface its message', () => {
  const log = '[stage] checkout\n[stage] build\nnpm ERR! missing script\n\n[error] Build failed\n[release] Current application was not replaced\n'
  const pipeline = parseDeploymentLog(log, 'failed', 'failed')
  assert.equal(pipeline.errorMessage, 'Build failed')
  assert.equal(pipeline.stages.find(stage => stage.key === 'build')?.state, 'failed')
  assert.equal(pipeline.stages.find(stage => stage.key === 'install')?.state, 'skipped')
  assert.equal(pipeline.stages.find(stage => stage.key === 'health')?.state, 'pending')
  assert.equal(pipeline.currentLabel, 'Failed at build')
})

test('list rows derive the pipeline from the phase column', () => {
  const states = (stages: ReturnType<typeof stagesFromPhase>) => stages.map(stage => stage.state).join(',')
  assert.equal(states(stagesFromPhase('running', 'build', '[stage] dependencies')), 'done,done,done,active,pending,pending,pending,pending')
  assert.equal(states(stagesFromPhase('running', 'security', '[stage] checkout')), 'done,done,pending,pending,active,pending,pending,pending')
  assert.equal(states(stagesFromPhase('success', 'complete')), 'done,done,done,done,done,done,done,done')
})

test('time helpers format compact durations and relative times', () => {
  assert.equal(formatSeconds(75), '1m 15s')
  assert.equal(formatSeconds(null), '—')
  const now = Date.parse('2026-09-30T12:00:00Z')
  assert.equal(relativeTime('2026-09-30T11:58:00Z', now), '2m ago')
  assert.equal(relativeTime('2026-09-29T12:00:00Z', now), '1d ago')
})
