/** Rules for promoting a staging app to production. Pure, so they can be tested without Git or a database. */

export const COMMIT_SHA = /^[a-f0-9]{7,40}$/i
/** Field and record separators for `git log --format`, chosen so commit subjects cannot collide with them. */
export const LOG_FORMAT = '%H%x1f%s%x1f%an%x1f%ad%x1e'

export interface PromotionCommit { sha: string; subject: string; author: string; date: string }

/**
 * Separate branches: the tested commit is merged into the production branch.
 * Same branch: production is moved to exactly the tested commit, since there is nothing to merge.
 */
export function promotionMode(stagingBranch: string, productionBranch: string): 'merge' | 'commit' {
  return stagingBranch === productionBranch ? 'commit' : 'merge'
}

export function parseCommitLog(output: string): PromotionCommit[] {
  return output.split('\x1e').map(record => record.replace(/^\s+/, '')).filter(Boolean).map(record => {
    const [sha = '', subject = '', author = '', date = ''] = record.split('\x1f')
    return { sha, subject: subject.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200), author: author.slice(0, 80), date }
  }).filter(commit => COMMIT_SHA.test(commit.sha))
}

/** Files that mean the release changes the database when it is built or started. */
export function databaseChangeFiles(files: string[]) {
  return files.map(file => file.replace(/\\/g, '/')).filter(file =>
    /(^|\/)migrations\/.+/.test(file) || /(^|\/)schema(\.[a-z]+)?\.prisma$/.test(file) || /(^|\/)database\/(migrations|seeders)\//.test(file))
}

export interface PromotionFacts {
  stagingSha: string | null
  productionSha: string | null
  /** Status of the most recent staging deployment attempt, which may be newer than the commit staging is running. */
  latestStagingStatus: string | null
  latestStagingSha: string | null
  /** Production already contains the commit staging runs. */
  alreadyIncluded: boolean
  /** The commit history between the two could be read. */
  historyKnown: boolean
  commits: PromotionCommit[]
  databaseFiles: string[]
}

/** Why promotion cannot start, or null. */
export function promotionBlocker(facts: PromotionFacts): string | null {
  if (!facts.stagingSha) return 'Staging has not been deployed successfully yet. Deploy staging first.'
  if (facts.productionSha && facts.productionSha === facts.stagingSha) return 'Production already runs this commit.'
  if (facts.alreadyIncluded) return 'Production already includes the commit staging is running. There is nothing to promote.'
  return null
}

/** Things the person should know before confirming. They do not stop the promotion. */
export function promotionWarnings(facts: PromotionFacts): string[] {
  const warnings: string[] = []
  if (facts.latestStagingStatus === 'failed') {
    warnings.push(facts.latestStagingSha && facts.latestStagingSha !== facts.stagingSha
      ? `Staging's most recent deployment (${facts.latestStagingSha.slice(0, 7)}) failed. Staging is still running ${facts.stagingSha?.slice(0, 7)}, and that is what will be promoted.`
      : 'Staging\'s most recent deployment attempt failed. The commit it is still running is what will be promoted.')
  }
  if (facts.latestStagingStatus === 'running' || facts.latestStagingStatus === 'queued') warnings.push('A staging deployment is running right now. Promotion uses the commit staging is currently serving, not the one being deployed.')
  if (facts.databaseFiles.length) warnings.push(`This release changes the database (${facts.databaseFiles.length} migration or schema file${facts.databaseFiles.length === 1 ? '' : 's'}). Back up the production database first.`)
  if (!facts.historyKnown) warnings.push('The list of changes could not be read from the staging checkout, so review the commits on GitHub before confirming.')
  return warnings
}

/** Reads a GitHub "compare two commits" response. Returns null when it is not usable. */
export function fromGitHubComparison(value: unknown): { alreadyIncluded: boolean; commits: PromotionCommit[]; files: string[] } | null {
  const body = value as { status?: string; commits?: unknown[]; files?: unknown[] } | null
  if (!body || typeof body.status !== 'string' || !['ahead', 'behind', 'identical', 'diverged'].includes(body.status)) return null
  const commits = (Array.isArray(body.commits) ? body.commits : []).map(entry => {
    const item = entry as { sha?: string; commit?: { message?: string; author?: { name?: string; date?: string } } }
    return { sha: String(item.sha || ''), subject: String(item.commit?.message || '').split('\n')[0].replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200),
      author: String(item.commit?.author?.name || '').slice(0, 80), date: String(item.commit?.author?.date || '').slice(0, 10) }
  }).filter(commit => COMMIT_SHA.test(commit.sha)).reverse().slice(0, 50)
  const files = (Array.isArray(body.files) ? body.files : []).map(entry => String((entry as { filename?: string }).filename || '')).filter(Boolean)
  // "behind" and "identical" mean the base (production) already contains the head (staging).
  return { alreadyIncluded: body.status === 'behind' || body.status === 'identical', commits, files }
}
