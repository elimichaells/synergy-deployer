import assert from 'node:assert/strict'
import test from 'node:test'
import { databaseChangeFiles, fromGitHubComparison, parseCommitLog, promotionBlocker, promotionMode, promotionWarnings, type PromotionFacts } from '../lib/promotion-policy'

const facts = (overrides: Partial<PromotionFacts> = {}): PromotionFacts => ({
  stagingSha: 'a424a8b1111111111111111111111111111111aa', productionSha: '4381979222222222222222222222222222222222', latestStagingStatus: 'success',
  latestStagingSha: 'a424a8b1111111111111111111111111111111aa', alreadyIncluded: false, historyKnown: true, commits: [], databaseFiles: [], ...overrides,
})

test('separate branches are merged; a shared branch moves production to the tested commit', () => {
  assert.equal(promotionMode('dev', 'main'), 'merge')
  assert.equal(promotionMode('main', 'main'), 'commit')
})

test('commit history is parsed without trusting control characters in subjects', () => {
  const log = ['a'.repeat(40), 'Fix login\ttab', 'Ama', '2026-10-01'].join('\x1f') + '\x1e\n' + ['b'.repeat(40), 'Add schema', 'Kofi', '2026-09-30'].join('\x1f') + '\x1e\n' + 'not-a-commit\x1fx\x1fy\x1fz\x1e'
  const commits = parseCommitLog(log)
  assert.equal(commits.length, 2)
  assert.deepEqual(commits[0], { sha: 'a'.repeat(40), subject: 'Fix login tab', author: 'Ama', date: '2026-10-01' })
  assert.deepEqual(parseCommitLog(''), [])
})

test('migration and schema files are recognised as database changes', () => {
  assert.deepEqual(databaseChangeFiles(['prisma/migrations/20261001_add/migration.sql', 'prisma/schema.prisma', 'prisma/schema.mysql.prisma', 'database/migrations/2026_create_users.php', 'src/app.ts', 'docs/migrations.md']),
    ['prisma/migrations/20261001_add/migration.sql', 'prisma/schema.prisma', 'prisma/schema.mysql.prisma', 'database/migrations/2026_create_users.php'])
})

test('promotion is refused when there is nothing tested to promote or production already has it', () => {
  assert.equal(promotionBlocker(facts()), null)
  assert.match(promotionBlocker(facts({ stagingSha: null }))!, /Deploy staging first/)
  assert.match(promotionBlocker(facts({ productionSha: 'a424a8b1111111111111111111111111111111aa' }))!, /already runs this commit/)
  assert.match(promotionBlocker(facts({ alreadyIncluded: true }))!, /nothing to promote/)
})

test('warnings explain a failed latest staging deployment, database changes and unknown history', () => {
  assert.deepEqual(promotionWarnings(facts()), [])
  const failed = promotionWarnings(facts({ latestStagingStatus: 'failed', latestStagingSha: 'ffffffff00000000000000000000000000000000' }))
  assert.match(failed[0], /most recent deployment \(fffffff\) failed\. Staging is still running a424a8b/)
  assert.match(promotionWarnings(facts({ latestStagingStatus: 'running' }))[0], /running right now/)
  assert.match(promotionWarnings(facts({ databaseFiles: ['prisma/migrations/x/migration.sql'] }))[0], /changes the database \(1 migration or schema file\)\. Back up/)
  assert.match(promotionWarnings(facts({ historyKnown: false }))[0], /could not be read/)
})

test('a GitHub comparison gives the commits to release, or shows production already has them', () => {
  const ahead = fromGitHubComparison({ status: 'ahead', commits: [
    { sha: 'a'.repeat(40), commit: { message: ['Older change', '', 'body'].join(String.fromCharCode(10)), author: { name: 'Ama', date: '2026-09-30T10:00:00Z' } } },
    { sha: 'b'.repeat(40), commit: { message: 'Newer change', author: { name: 'Kofi', date: '2026-10-01T10:00:00Z' } } },
  ], files: [{ filename: 'prisma/migrations/1/migration.sql' }, { filename: 'src/a.ts' }] })!
  assert.equal(ahead.alreadyIncluded, false)
  assert.deepEqual(ahead.commits.map(commit => commit.subject), ['Newer change', 'Older change'])
  assert.equal(ahead.commits[0].date, '2026-10-01')
  assert.deepEqual(ahead.files, ['prisma/migrations/1/migration.sql', 'src/a.ts'])
  assert.equal(fromGitHubComparison({ status: 'behind', commits: [], files: [] })!.alreadyIncluded, true)
  assert.equal(fromGitHubComparison({ status: 'identical' })!.alreadyIncluded, true)
  assert.equal(fromGitHubComparison({ status: 'diverged', commits: [] })!.alreadyIncluded, false)
  assert.equal(fromGitHubComparison(null), null)
  assert.equal(fromGitHubComparison({ message: 'Not Found' }), null)
})
