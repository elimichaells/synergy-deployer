import { Button } from '@/components/ui/button'
import { GitBranch, Link2, LockKeyhole, Search } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import type { ReactNode } from 'react'
const GitHubIcon = GitBranch
export interface RepositoryOption { id?: number; name: string; fullName: string; avatarUrl?: string; private: boolean; defaultBranch: string; cloneUrl: string; registered?: boolean }
export function RepositoryPicker({ connections, connectionId, onConnectionChange, search, onSearchChange, loading, repos, canCreate, onImportRepo, urlInput, onUrlChange, onImportUrl, projectHint }: {
  connections: { id: string; name: string; provider?: string; account_login?: string }[]; connectionId: string; onConnectionChange: (id: string) => void
  search: string; onSearchChange: (value: string) => void; loading: boolean; repos: RepositoryOption[]; canCreate: boolean
  onImportRepo: (repo: RepositoryOption) => void; urlInput: string; onUrlChange: (value: string) => void; onImportUrl: () => void; projectHint?: ReactNode
}) {
  const visible = repos.filter(repo => repo.fullName.toLowerCase().includes(search.toLowerCase()))
  return (
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(300px,1fr)]">
        <section className="overflow-hidden rounded-xl border border-border bg-card" aria-label="Import Git repository">
          <div className="border-b border-border p-5">
            <h2 className="text-lg font-semibold tracking-tight">Import Git Repository</h2>
            <div className="mt-4 flex flex-wrap gap-2">
              <div className="relative min-w-[180px]">
                <GitHubIcon className="pointer-events-none absolute left-3 top-2.5 h-4 w-4" />
                <select aria-label="Git connection" className="control-input pl-9" value={connectionId} onChange={event => onConnectionChange(event.target.value)}>
                  <option value="">Public GitHub (no connection)</option>
                  {connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name} · {connection.provider} · {connection.account_login}</option>)}
                </select>
              </div>
              <div className="relative min-w-[200px] flex-1"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><input aria-label="Search repositories" className="control-input pl-9" value={search} onChange={event => onSearchChange(event.target.value)} placeholder="Search…" /></div>
            </div>
          </div>
          <div className="max-h-[480px] min-h-48 overflow-y-auto" aria-busy={loading}>
            {loading ? <div className="divide-y divide-border">{[0, 1, 2, 3, 4].map(i => <div key={i} className="flex items-center gap-3 px-5 py-4"><div className="h-8 w-8 animate-pulse rounded-full bg-white/[0.05]" /><div className="h-3 w-48 animate-pulse rounded bg-white/[0.05]" /></div>)}</div>
              : !connections.length ? (
                <div className="px-6 py-14 text-center">
                  <GitHubIcon className="mx-auto mb-3 h-6 w-6" />
                  <p className="text-sm font-medium">Connect Git provider to see your repositories</p>
                  <p className="mt-1 text-xs text-muted-foreground">Or paste a public repository URL on the right.</p>
                  <Button asChild size="sm" variant="outline" className="mt-4"><Link href="/settings?section=github">Connect Git provider</Link></Button>
                </div>
              ) : !visible.length ? <p className="py-14 text-center text-sm text-muted-foreground">No repositories match “{search}”.</p>
              : <div className="divide-y divide-border">{visible.map(repo => (
                <div key={repo.fullName} className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-white/[0.02]">
                  {repo.avatarUrl ? <Image src={repo.avatarUrl} alt="" width={32} height={32} unoptimized className="h-8 w-8 shrink-0 rounded-full" /> : <span className="flex h-8 w-8 items-center justify-center rounded-full border border-border"><GitHubIcon /></span>}
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 truncate text-sm font-medium">{repo.name}{repo.private && <LockKeyhole className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Private" />}</p>
                    <p className="truncate text-xs text-muted-foreground">{repo.fullName}{repo.registered ? ' · already imported' : ''}</p>
                  </div>
                  <Button size="sm" variant={repo.registered ? 'outline' : 'default'} onClick={() => onImportRepo(repo)} disabled={!canCreate}>Import</Button>
                </div>
              ))}</div>}
          </div>
        </section>

        <aside className="space-y-4">
          <section className="rounded-xl border border-border bg-card p-5">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><Link2 className="h-4 w-4" />Import from a URL</h2>
            <p className="mt-1 text-xs text-muted-foreground">Select a GitHub, GitLab or Gitea connection, then paste an HTTPS clone URL from that server.</p>
            <form className="mt-4 flex gap-2" onSubmit={event => { event.preventDefault(); onImportUrl() }}>
              <input aria-label="Repository URL" className="control-input font-mono text-xs" value={urlInput} onChange={event => onUrlChange(event.target.value)} placeholder="https://github.com/org/repo" />
              <Button type="submit" variant="outline" disabled={!urlInput.trim() || !canCreate}>Continue</Button>
            </form>
          </section>
          {projectHint}
          <section className="rounded-xl border border-border bg-card p-5 text-xs text-muted-foreground">
            <p className="mb-3 text-sm font-semibold text-foreground">What happens next</p>
            <ol className="space-y-2.5">
              {['Synergy clones the repository and detects the framework', 'You choose a database, environment variables and a domain', 'The app is built, health-checked and released to its configured address'].map((text, index) => (
                <li key={text} className="flex gap-2.5"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border font-mono text-[10px] text-foreground">{index + 1}</span>{text}</li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
  )
}
