'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { AppShell } from '@/components/layout/app-shell'

interface SessionUser {
  id: string
  email: string
  name: string
  role: 'admin' | 'operator' | 'viewer'
}

interface GithubRepo {
  id: number
  name: string
  fullName: string
  owner: string
  avatarUrl: string
  private: boolean
  defaultBranch: string
  cloneUrl: string
  htmlUrl: string
  updatedAt: string
  registered: boolean
}

const projectTypeDefaults = {
  next: { label: 'Next.js', installCmd: 'npm install', buildCmd: 'npm run build', startCmd: 'npm start' },
  angular: { label: 'Angular', installCmd: 'npm install', buildCmd: 'npm run build', startCmd: '' },
  go: { label: 'Go', installCmd: 'go mod download', buildCmd: 'go build -o app.exe .', startCmd: '.\\app.exe' },
  laravel: {
    label: 'Laravel',
    installCmd: 'composer install --no-dev --optimize-autoloader',
    buildCmd: 'php artisan config:cache && php artisan route:cache && php artisan view:cache',
    startCmd: 'php artisan serve --host=127.0.0.1',
  },
  node: { label: 'Node.js', installCmd: 'npm install', buildCmd: 'npm run build', startCmd: 'npm start' },
}

type ProjectType = keyof typeof projectTypeDefaults

export default function NewSitePage() {
  const router = useRouter()
  const [user, setUser] = useState<SessionUser | null>(null)
  const [creating, setCreating] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [repos, setRepos] = useState<GithubRepo[]>([])
  const [reposLoading, setReposLoading] = useState(true)
  const [githubConnected, setGithubConnected] = useState(false)
  const [selectedRepo, setSelectedRepo] = useState<GithubRepo | null>(null)
  const [repoSearch, setRepoSearch] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({
    name: '',
    projectType: 'next' as ProjectType,
    repoUrl: '',
    defaultBranch: 'main',
    rootPath: '',
    installCmd: 'npm install',
    buildCmd: 'npm run build',
    startCmd: 'npm start',
    pm2Name: '',
    port: '',
    url: '',
  })

  useEffect(() => {
    const load = async () => {
      const [meRes, reposRes] = await Promise.all([
        fetch('/api/auth/me'),
        fetch('/api/github/repos'),
      ])
      const meData = meRes.ok ? await meRes.json() : { user: null }
      setUser(meData.user)
      if (reposRes.ok) {
        const reposData = await reposRes.json()
        setGithubConnected(!!reposData.connected)
        setRepos(reposData.repos || [])
      }
      setReposLoading(false)
    }
    void load()
  }, [])

  const canWrite = user?.role === 'admin' || user?.role === 'operator'
  const visibleRepos = useMemo(() => {
    const q = repoSearch.trim().toLowerCase()
    if (!q) return repos
    return repos.filter((repo) =>
      repo.fullName.toLowerCase().includes(q) || repo.name.toLowerCase().includes(q)
    )
  }, [repoSearch, repos])

  const handleSelectRepo = (repo: GithubRepo) => {
    const defaults = projectTypeDefaults[form.projectType]
    setSelectedRepo(repo)
    setForm({
      ...form,
      name: repo.name,
      repoUrl: repo.cloneUrl,
      defaultBranch: repo.defaultBranch || 'main',
      installCmd: defaults.installCmd,
      buildCmd: defaults.buildCmd,
      startCmd: defaults.startCmd,
      pm2Name: '',
      rootPath: '',
      port: '',
    })
  }

  const handleDiscover = async () => {
    if (!canWrite) return
    setDiscovering(true)
    setError(null)
    try {
      const res = await fetch('/api/sites/discover', { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Auto-register failed')
      }
      router.push('/sites')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed')
    } finally {
      setDiscovering(false)
    }
  }

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canWrite) return

    setCreating(true)
    setError(null)

    const payload = {
      name: form.name.trim() || selectedRepo?.name || '',
      projectType: form.projectType,
      repoUrl: form.repoUrl.trim() || selectedRepo?.cloneUrl || '',
      defaultBranch: form.defaultBranch.trim(),
      rootPath: form.rootPath.trim() || null,
      installCmd: form.installCmd.trim() || null,
      buildCmd: form.buildCmd.trim() || null,
      startCmd: form.startCmd.trim() || null,
      pm2Name: form.pm2Name.trim() || null,
      port: form.port ? Number(form.port) : null,
      url: form.url.trim() || null,
    }

    try {
      const res = await fetch('/api/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to create project')
      }
      router.push('/sites')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create site')
    } finally {
      setCreating(false)
    }
  }

  return (
    <AppShell
      title="Create New Site"
      subtitle="Register a new site or sync from host environment."
      user={{ name: user?.name, role: user?.role }}
      actions={null}
    >
      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card className="surface-card">
          <CardHeader>
            <CardTitle className="text-foreground">Site Registration</CardTitle>
            <CardDescription className="text-muted-foreground">
              Select a GitHub repository. The manager will assign paths, PM2 IDs, and ports automatically.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-4 md:grid-cols-2" onSubmit={handleCreate}>
              <div className="md:col-span-2 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <input
                    className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-foreground"
                    placeholder="Search GitHub repositories"
                    value={repoSearch}
                    onChange={(e) => setRepoSearch(e.target.value)}
                  />
                  <Link href="/settings" className="text-xs text-muted-foreground hover:text-white whitespace-nowrap">
                    GitHub settings
                  </Link>
                </div>
                <div className="max-h-72 overflow-auto rounded-lg border border-white/[0.08] bg-black/30">
                  {reposLoading ? (
                    <div className="px-4 py-6 text-sm text-muted-foreground">Loading repositories...</div>
                  ) : !githubConnected ? (
                    <div className="px-4 py-6 text-sm text-muted-foreground">
                      GitHub is not connected. Connect it in Settings to select repositories here.
                    </div>
                  ) : visibleRepos.length === 0 ? (
                    <div className="px-4 py-6 text-sm text-muted-foreground">No repositories found.</div>
                  ) : visibleRepos.map((repo) => (
                    <button
                      type="button"
                      key={repo.id}
                      onClick={() => handleSelectRepo(repo)}
                      disabled={repo.registered}
                      className={`flex w-full items-center justify-between gap-3 border-b border-white/[0.08] px-4 py-3 text-left last:border-b-0 transition-colors ${
                        selectedRepo?.id === repo.id ? 'bg-blue-500/10' : 'hover:bg-white/[0.05]'
                      } ${repo.registered ? 'opacity-50' : ''}`}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{repo.fullName}</p>
                        <p className="text-xs text-muted-foreground">
                          {repo.private ? 'Private' : 'Public'} · {repo.defaultBranch}
                        </p>
                      </div>
                      <span className="text-xs text-muted-foreground">{repo.registered ? 'Registered' : 'Select'}</span>
                    </button>
                  ))}
                </div>
              </div>
              <select
                className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-foreground"
                value={form.projectType}
                onChange={(e) => {
                  const projectType = e.target.value as ProjectType
                  const defaults = projectTypeDefaults[projectType]
                  setForm({
                    ...form,
                    projectType,
                    installCmd: defaults.installCmd,
                    buildCmd: defaults.buildCmd,
                    startCmd: defaults.startCmd,
                  })
                }}
              >
                {Object.entries(projectTypeDefaults).map(([value, item]) => (
                  <option key={value} value={value}>{item.label}</option>
                ))}
              </select>
              <input
                className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-foreground"
                placeholder="Site name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <input
                className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-foreground"
                placeholder="Default branch"
                value={form.defaultBranch}
                onChange={(e) => setForm({ ...form, defaultBranch: e.target.value })}
              />
              <input
                className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-foreground"
                placeholder="Public URL (optional)"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
              />
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="md:col-span-2 text-left text-xs text-muted-foreground hover:text-white"
              >
                {showAdvanced ? 'Hide advanced overrides' : 'Show advanced overrides'}
              </button>
              {showAdvanced && (
                <>
                  <input
                    className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-foreground"
                    placeholder="GitHub repo URL override"
                    value={form.repoUrl}
                    onChange={(e) => setForm({ ...form, repoUrl: e.target.value })}
                  />
                  <input
                    className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-foreground"
                    placeholder="PM2 identifier override"
                    value={form.pm2Name}
                    onChange={(e) => setForm({ ...form, pm2Name: e.target.value })}
                  />
                  <input
                    className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-foreground"
                    placeholder="Root path override"
                    value={form.rootPath}
                    onChange={(e) => setForm({ ...form, rootPath: e.target.value })}
                  />
                  <input
                    className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-foreground"
                    placeholder="Port override"
                    value={form.port}
                    onChange={(e) => setForm({ ...form, port: e.target.value })}
                  />
                </>
              )}
              <input
                className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-foreground"
                placeholder="Install command"
                value={form.installCmd}
                onChange={(e) => setForm({ ...form, installCmd: e.target.value })}
              />
              <input
                className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-foreground"
                placeholder="Build command"
                value={form.buildCmd}
                onChange={(e) => setForm({ ...form, buildCmd: e.target.value })}
              />
              <input
                className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-foreground"
                placeholder="Start command"
                value={form.startCmd}
                onChange={(e) => setForm({ ...form, startCmd: e.target.value })}
              />
              <div className="md:col-span-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2.5">
                <p className="text-xs font-medium text-amber-400">Automatic runtime setup</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Production and staging folders, PM2 process names, and an available production/staging port pair will be assigned in the background.
                </p>
              </div>
              <div className="md:col-span-2 flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  Only admins/operators can add projects.
                </p>
                <Button type="submit" disabled={!canWrite || creating}>
                  {creating ? 'Creating...' : 'Create Site'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card className="surface-card">
          <CardHeader>
            <CardTitle className="text-foreground">Sync From Production</CardTitle>
            <CardDescription className="text-muted-foreground">
              Auto-register any folders under the production directory.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              This will scan the production folder and register any missing projects with their
              staging counterparts auto-created. You can update GitHub repo URLs later.
            </p>
            <Button size="sm" variant="secondary" onClick={handleDiscover} disabled={!canWrite || discovering}>
              {discovering ? 'Scanning...' : 'Sync from Production'}
            </Button>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
