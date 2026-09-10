import type { CommandResult } from './exec'

type Execute = (command: string) => Promise<CommandResult>

function changedFileSummary(output: string) {
  const files = output.split(/\r?\n/)
    .filter(Boolean)
    .map(line => line.length > 3 ? line.slice(3).trim() : '')
    .filter(Boolean)
    .map(file => file.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 160))
  if (!files.length) return ''
  const shown = files.slice(0, 8)
  const remainder = files.length - shown.length
  return ` Changed tracked files: ${shown.join(', ')}${remainder ? `, and ${remainder} more` : ''}.`
}

export async function assertCleanDeploymentCheckout(execute: Execute) {
  const status = await execute('git status --porcelain=v1 --untracked-files=no')
  if (status.code !== 0) throw new Error('Could not check local source changes; deployment stopped without changing the checkout')
  if (status.output.trim()) {
    throw new Error('Local source changes detected. Deployment stopped to preserve them.' + changedFileSummary(status.output) + ' Review and commit/push the intended changes before redeploying; Manager will not discard them.')
  }
}

export async function syncDeploymentCheckout(target: string, execute: Execute, append: (message: string) => void | Promise<void>) {
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(target)) throw new Error('Invalid deployment Git reference')
  await assertCleanDeploymentCheckout(execute)
  // Compare against the freshly fetched target, not a possibly stale origin tracking ref.
  const ahead = await execute(`git rev-list --count "${target}..HEAD"`)
  if (ahead.code !== 0 || !/^\d+$/.test(ahead.output.trim())) {
    throw new Error('Could not verify local Git history; deployment stopped without resetting the checkout')
  }
  if (Number(ahead.output.trim()) > 0) {
    throw new Error('Local commits are missing from the fetched deployment branch. Review and push or preserve those commits before deploying; Manager will not discard them.')
  }
  await append(`[checkout] Updating to ${target}, preserving local files\n`)
  // A guarded fast-forward also refuses collisions with ignored files such as .env.
  const result = await execute(`git merge --ff-only --no-autostash --no-overwrite-ignore "${target}"`)
  if (result.code !== 0) {
    throw new Error('Checkout update refused by Git. Preserve and reconcile local files before redeploying; no forced reset was attempted.')
  }
}
