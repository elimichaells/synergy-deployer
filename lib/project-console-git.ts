import {consoleGitArguments as parseConsoleGit} from '../scripts/console-policy.cjs'
import { ApiError } from '@/lib/api'
import { prepareGitAccess, gitEnvironment, installedGit } from '@/lib/git-access'

// Only standalone network commands receive credentials. Shell commands such as
// `set`, scripts and `git config` continue to run without the saved token.
export function consoleGitArguments(command:string){try{return parseConsoleGit(command)}catch(error){throw new ApiError((error as Error).message,400)}}
export async function prepareConsoleGit(command: string, app: { root_path: string; repo_url?: string | null; github_connection_id?: string | null }) {
  if (!app.repo_url?.startsWith('https://')) return null
  const args = consoleGitArguments(command)
  if (!args) return null
  const access = await prepareGitAccess(app)
  return { command: { file: installedGit(app.root_path), args }, env: gitEnvironment(access.config, app.root_path), secrets: access.secrets, authenticated: access.authenticated }

}

export function consoleGitFailureHint(output: string) {
  if (!/Authentication failed|Invalid username or token|could not read Username|could not read Password|Repository not found|Permission .* denied/i.test(output)) return ''
  return '\n[auth] Check the Git connection selected in this application’s Setup. Test or update it in Settings > Connections > Git connections and ensure it can access this repository (write access is required for push). Then retry the command.\n'
}
