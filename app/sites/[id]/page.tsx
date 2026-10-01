'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import {
  Activity, ArrowRight, ArrowUpRight, Check, Copy, Database, GitBranch, GitCommitHorizontal, Globe2, Layers,
  Loader2, Play, RefreshCw, Rocket, RotateCw, Square, Terminal, Trash2, Workflow, Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { AppToolGrid } from '@/components/app/app-tools'
import { AppShell } from '@/components/layout/app-shell'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EnvEditor } from '@/components/env-editor'
import { ProjectSetup } from '@/components/project-setup'
import { RuntimeManager } from '@/components/runtime-manager'
import { DeploymentRow } from '@/components/synergy/deployment-row'
import { FrameworkAvatar } from '@/components/synergy/framework-logo'
import { EnvironmentBadge, StatusLabel, type DeployStatus } from '@/components/synergy/status'
import { Section, StatusLine, roleLabels } from '@/components/app/section'
import { StoragePanel, providerMeta } from '@/components/app/storage-panel'
import { DomainsPanel } from '@/components/app/domains-panel'
import { StackPanel } from '@/components/app/stack-panel'
import { PROJECT_TYPES as projectTypeDefaults, getProjectCommandOverrides, type ProjectType } from '@/lib/project-types'
import { deploymentDuration, formatSeconds, relativeTime } from '@/lib/deployment-stages'
import { cn } from '@/lib/utils'

interface Project {
  setup_required?: boolean
  id: string
  name: string
  slug: string
  repo_url: string | null
  default_branch: string
  project_type: ProjectType
  root_path: string
  pm2_name: string
  install_cmd?: string | null
  build_cmd?: string | null
  deploy_script?: string | null
  start_cmd?: string | null
  pre_deploy_cmd?: string | null
  post_deploy_cmd?: string | null
  runtime_versions: { node?: string; php?: string; go?: string }
  auto_deploy: boolean
  github_connection_id: string | null
  github_connection_name: string | null
  github_account_login: string | null
  port: number | null
  url: string | null
  is_active: boolean
  environment: 'production' | 'staging'
  production_id: string | null
  staging_id: string | null
  staging_name: string | null
  production_name: string | null
}

interface GitHubConnectionOption { id: string; name: string; account_login: string }

interface Deployment {
  log?: string | null
  is_active?: boolean
  phase?: string
  security_status?: string
  user_name?: string | null
  trigger?: string | null
  id: string
  project_id: string
  status: DeployStatus
  branch: string | null
  commit_sha: string | null
  started_at: string | null
  finished_at: string | null
}

interface DataServiceSummary { id: string; database_name: string; provider: keyof typeof providerMeta; application_primary: boolean; shared_from_project_name?: string | null }
interface StackSummary { application_group_id: string | null; group_name: string | null; component_role: string; members: { id: string; environment: string }[] }
interface ToolchainRuntime { id: 'node' | 'php' | 'go'; name: string; installedVersions: string[] }

const TABS = ['overview', 'deployments', 'storage', 'domains', 'environment', 'logs', 'console', 'settings', 'setup'] as const
type Tab = typeof TABS[number]
const tabFromParam = (value: string | null): Tab => value === 'config' ? 'environment' : TABS.includes(value as Tab) ? value as Tab : 'overview'

function logClass(line: string) {
  const lower = line.toLowerCase()
  const status = Number(line.match(/\b([1-5]\d{2})\b/)?.[1] || 0)
  const http = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(line)
  if (line.startsWith('PS ')) return 'mt-2 font-medium text-white'
  if (line.startsWith('[exit]') && line.endsWith('code 0')) return 'text-emerald-400'
  if (/error|fatal|exception|elifecycle/.test(lower)) return 'font-medium text-[#ff8a8a]'
  if (/warn|deprecat/.test(lower)) return 'text-[#f5c26b]'
  if (status >= 500) return 'text-[#ff8a8a]'
  if (status >= 400) return 'text-[#fb923c]'
  if (http && status >= 200 && status < 300) return 'text-[#5fe0a6]'
  if (http && status >= 300 && status < 400) return 'text-[#8fb8ff]'
  if (/ready|started|listening|compiled/.test(lower)) return 'text-[#5fe0a6]'
  if (/\b(info|event)\b/.test(lower)) return 'text-[#8fb8ff]'
  if (/debug|trace|verbose/.test(lower)) return 'text-white/35'
  return 'text-[#d6d6d6]'
}

function renderLogLines(text: string) {
  const cleaned = text
    .replace(/#<\s*CLIXML[\s\S]*?(?:<\/Objs>|$)/gi, '')
    .replace(/<Objs\s+Version="[^"]+"\s+xmlns="http:\/\/schemas\.microsoft\.com\/powershell\/2004\/04">[\s\S]*?(?:<\/Objs>|$)/gi, '')
  return cleaned.split(/\r?\n/).map((line, index) => {
    const timestamp = line.match(/^(\d{4}-\d{2}-\d{2}[\sT][\d:.,+\-Z]+\s*[|:\-]?\s*|\[[\d\s:.,/\-TZ+]+\]\s*)/)
    return (
      <div key={`${index}-${line.slice(0, 12)}`} className={logClass(line)}>
        {timestamp ? <><span className="text-white/35">{timestamp[1]}</span>{line.slice(timestamp[1].length)}</> : line || ' '}
      </div>
    )
  })
}

const repoLabel = (url: string | null | undefined) => url?.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '') || null
const commitUrl = (repo: string | null | undefined, sha: string | null) => {
  const match = repo && /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repo)
  return match && sha ? `https://github.com/${match[1]}/${match[2]}/commit/${sha}` : null
}

export default function SitePage() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const siteId = Array.isArray(params.id) ? params.id[0] : params.id
  const [project, setProject] = useState<Project | null>(null)
  const [userRole, setUserRole] = useState<'admin' | 'operator' | 'viewer'>('viewer')
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [productionDeployment, setProductionDeployment] = useState<Deployment | null>(null)
  const [dataServices, setDataServices] = useState<DataServiceSummary[]>([])
  const [domains, setDomains] = useState<string[]>([])
  const [stack, setStack] = useState<StackSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<Tab>('overview')
  const [deploying, setDeploying] = useState(false)
  const [promoting, setPromoting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [envFile, setEnvFile] = useState('.env')
  const [envContent, setEnvContent] = useState('')
  const [envSaved, setEnvSaved] = useState(false)
  const [savingEnv, setSavingEnv] = useState(false)
  const [logsType, setLogsType] = useState<'out' | 'err'>('out')
  const [logs, setLogs] = useState('')
  const [logsPath, setLogsPath] = useState('')
  const [logsStatus, setLogsStatus] = useState<string | null>(null)
  const [clock, setClock] = useState(() => Date.now())
  const [savingProject, setSavingProject] = useState(false)
  const [projectSaved, setProjectSaved] = useState(false)
  const [savingAutoDeploy, setSavingAutoDeploy] = useState(false)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [projectForm, setProjectForm] = useState({
    name: '', projectType: 'next' as ProjectType, repoUrl: '', defaultBranch: '', rootPath: '', pm2Name: '', port: '', url: '',
    installCmd: '', buildCmd: '', deployScript: '', startCmd: '', preDeployCmd: '', postDeployCmd: '', autoDeploy: true, githubConnectionId: '',
    runtimeVersions: {} as { node?: string; php?: string; go?: string },
  })
  const [githubConnections, setGithubConnections] = useState<GitHubConnectionOption[]>([])
  const [webhookSecret, setWebhookSecret] = useState<string | null>(null)
  const [webhookHasSecret, setWebhookHasSecret] = useState(false)
  const [webhookGenerating, setWebhookGenerating] = useState(false)
  const [webhookCopied, setWebhookCopied] = useState<'url' | 'secret' | null>(null)
  const [ghHookInstalled, setGhHookInstalled] = useState<boolean | null>(null)
  const [ghHookInstalling, setGhHookInstalling] = useState(false)
  const [ghHookRemoving, setGhHookRemoving] = useState(false)
  const [ghHookError, setGhHookError] = useState<string | null>(null)
  const [clearingLogs, setClearingLogs] = useState(false)
  const [consoleCommands, setConsoleCommands] = useState<string[]>([])
  const [npmScripts, setNpmScripts] = useState<Record<string, string>>({})
  const [npmCommand, setNpmCommand] = useState('')
  const [npmOutput, setNpmOutput] = useState('')
  const [consoleCwd, setConsoleCwd] = useState('')
  const [consoleHistory, setConsoleHistory] = useState<string[]>([])
  const [consoleHistoryIndex, setConsoleHistoryIndex] = useState(-1)
  const [consoleCopied, setConsoleCopied] = useState(false)
  const [npmRunning, setNpmRunning] = useState(false)
  const npmAbortRef = useRef<AbortController | null>(null)
  const npmOutputRef = useRef<HTMLDivElement>(null)
  const terminalInputRef = useRef<HTMLInputElement>(null)
  const [cancellingDeploy, setCancellingDeploy] = useState<string | null>(null)
  const [rollingBack, setRollingBack] = useState<string | null>(null)
  const [toolchainRuntimes, setToolchainRuntimes] = useState<ToolchainRuntime[]>([])
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleting, setDeleting] = useState(false)

  const canWrite = userRole === 'admin' || userRole === 'operator'

  useEffect(() => {
    let current = true
    void fetch('/api/auth/me').then(response => response.ok ? response.json() : null).then(body => { if (current) setUserRole(body?.user?.role || 'viewer') }).catch(() => {})
    return () => { current = false }
  }, [])

  useEffect(() => {
    const selectTab = () => setActiveTab(tabFromParam(new URLSearchParams(window.location.search).get('tab')))
    selectTab()
    window.addEventListener('popstate', selectTab)
    return () => window.removeEventListener('popstate', selectTab)
  }, [siteId, searchParams])

  const changeTab = (value: string) => {
    const tab = tabFromParam(value)
    setActiveTab(tab)
    window.history.replaceState(null, '', `?tab=${tab}`)
    if (tab === 'settings') void loadWebhook()
  }

  const loadToolchainRuntimes = useCallback(async () => {
    const response = await fetch('/api/system/runtimes?toolchains=true', { cache: 'no-store' })
    if (!response.ok) return
    setToolchainRuntimes(((await response.json()).runtimes || []).filter((runtime: ToolchainRuntime) => ['node', 'php', 'go'].includes(runtime.id)))
  }, [])

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const [projectRes, deploymentsRes, connectionsRes, dataServicesRes, runtimesRes, domainsRes, stackRes] = await Promise.all([
        fetch(`/api/sites/${siteId}`),
        fetch(`/api/deployments?project_id=${encodeURIComponent(siteId || '')}`, { cache: 'no-store' }),
        fetch('/api/github/connections'),
        fetch(`/api/sites/${siteId}/data-services`, { cache: 'no-store' }),
        fetch('/api/system/runtimes?toolchains=true'),
        fetch(`/api/domains?project=${siteId}`, { cache: 'no-store' }),
        fetch(`/api/sites/${siteId}/related`, { cache: 'no-store' }),
      ])
      if (!projectRes.ok) throw new Error('Failed to load application')
      if (!deploymentsRes.ok) throw new Error('Failed to load deployments')
      const projectData = await projectRes.json()
      const deploymentsData = await deploymentsRes.json()
      if (connectionsRes.ok) setGithubConnections((await connectionsRes.json()).connections || [])
      if (dataServicesRes.ok) setDataServices((await dataServicesRes.json()).services || [])
      if (runtimesRes.ok) setToolchainRuntimes(((await runtimesRes.json()).runtimes || []).filter((runtime: ToolchainRuntime) => ['node', 'php', 'go'].includes(runtime.id)))
      if (domainsRes.ok) setDomains(((await domainsRes.json()).domains || []).map((domain: { hostname: string }) => domain.hostname))
      if (stackRes.ok) setStack(await stackRes.json())
      if (projectData.environment === 'staging' && projectData.production_id) {
        const prodRes = await fetch(`/api/deployments?project_id=${projectData.production_id}&status=success&limit=1`).catch(() => null)
        const prodData = prodRes?.ok ? await prodRes.json() : []
        if (prodData.length > 0) setProductionDeployment(prodData[0])
      }
      setProject(projectData)
      setDeployments(deploymentsData.filter((item: Deployment) => item.project_id === siteId))
      setProjectForm({
        name: projectData.name || '',
        projectType: projectData.project_type || 'next',
        repoUrl: projectData.repo_url || '',
        defaultBranch: projectData.default_branch || 'main',
        rootPath: projectData.root_path || '',
        pm2Name: projectData.pm2_name || '',
        port: projectData.port ? String(projectData.port) : '',
        url: projectData.url || '',
        ...getProjectCommandOverrides(projectData),
        deployScript: projectData.deploy_script || '',
        preDeployCmd: projectData.pre_deploy_cmd || '',
        postDeployCmd: projectData.post_deploy_cmd || '',
        autoDeploy: projectData.auto_deploy !== false,
        githubConnectionId: projectData.github_connection_id || '',
        runtimeVersions: projectData.runtime_versions || {},
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [siteId])

  const loadEnv = useCallback(async (file: string) => {
    try {
      const res = await fetch(`/api/sites/${siteId}/env?file=${encodeURIComponent(file)}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to load env file')
      }
      setEnvContent((await res.json()).content || '')
    } catch (err) {
      setEnvContent('')
      setError(err instanceof Error ? err.message : 'Failed to load env file')
    }
  }, [siteId])

  useEffect(() => { if (siteId) void refresh() }, [siteId, refresh])
  useEffect(() => { if (siteId && activeTab === 'environment') void loadEnv(envFile) }, [envFile, siteId, loadEnv, activeTab])

  useEffect(() => {
    if (!siteId || activeTab !== 'logs') return
    setLogsStatus('Connecting…')
    const eventSource = new EventSource(`/api/sites/${siteId}/logs/stream?type=${logsType}&lines=200`)
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        setLogs(data.log || '')
        setLogsPath(data.logPath || '')
        setLogsStatus(null)
      } catch { /* ignore malformed frames */ }
    }
    eventSource.onerror = () => {
      eventSource.close()
      setLogsStatus('Live stream unavailable. Showing a snapshot.')
      fetch(`/api/sites/${siteId}/logs?type=${logsType}&lines=200`)
        .then(res => (res.ok ? res.json() : null))
        .then(data => {
          if (!data) return
          setLogs(data.log || '')
          setLogsPath(data.logPath || '')
          setLogsStatus(data.log ? null : 'No logs yet.')
        })
        .catch(() => setLogsStatus('Unable to load logs.'))
    }
    return () => eventSource.close()
  }, [logsType, siteId, activeTab])

  const handleDeploy = async () => {
    if (!siteId) return
    setDeploying(true)
    setError(null)
    try {
      const res = await fetch(`/api/sites/${siteId}/deploy`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'Deployment failed')
      // Follow the new release on its own pipeline page.
      if (body.deploymentId) {
        router.push(`/deployments/${body.deploymentId}`)
        return
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deployment failed')
    } finally {
      setDeploying(false)
    }
  }

  const handlePromote = async () => {
    if (!siteId) return
    setPromoting(true)
    setError(null)
    try {
      const res = await fetch(`/api/sites/${siteId}/promote`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'Promotion failed')
      if (body.productionId) router.push(`/sites/${body.productionId}`)
      else await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Promotion failed')
    } finally {
      setPromoting(false)
    }
  }

  const handleSaveEnv = async () => {
    setSavingEnv(true)
    setError(null)
    try {
      const res = await fetch(`/api/sites/${siteId}/env`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: envFile, content: envContent }) })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to save env file')
      }
      setEnvSaved(true)
      window.setTimeout(() => setEnvSaved(false), 2500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save env file')
    } finally {
      setSavingEnv(false)
    }
  }

  const handleSaveProject = async () => {
    if (!siteId) return
    setSavingProject(true)
    setError(null)
    try {
      const payload = {
        name: projectForm.name.trim(),
        projectType: projectForm.projectType,
        repoUrl: projectForm.repoUrl.trim() || null,
        defaultBranch: projectForm.defaultBranch.trim() || 'main',
        rootPath: projectForm.rootPath.trim(),
        pm2Name: projectForm.pm2Name.trim(),
        port: projectForm.port ? Number(projectForm.port) : null,
        url: projectForm.url.trim() || null,
        installCmd: projectForm.installCmd.trim() || null,
        buildCmd: projectForm.buildCmd.trim() || null,
        deployScript: projectForm.deployScript.trim() || null,
        startCmd: projectForm.startCmd.trim() || null,
        preDeployCmd: projectForm.preDeployCmd.trim() || null,
        postDeployCmd: projectForm.postDeployCmd.trim() || null,
        autoDeploy: projectForm.autoDeploy,
        githubConnectionId: projectForm.githubConnectionId || null,
        runtimeVersions: projectForm.runtimeVersions,
      }
      const res = await fetch(`/api/sites/${siteId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to save settings')
      }
      await refresh()
      setProjectSaved(true)
      window.setTimeout(() => setProjectSaved(false), 2500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings')
    } finally {
      setSavingProject(false)
    }
  }

  const handleToggleAutoDeploy = async () => {
    if (!siteId || !project || savingAutoDeploy) return
    const previousValue = project.auto_deploy
    const nextValue = !previousValue
    setSavingAutoDeploy(true)
    setError(null)
    setProject({ ...project, auto_deploy: nextValue })
    setProjectForm(current => ({ ...current, autoDeploy: nextValue }))
    try {
      const res = await fetch(`/api/sites/${siteId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoDeploy: nextValue }) })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to update auto deployment')
      }
    } catch (err) {
      setProject({ ...project, auto_deploy: previousValue })
      setProjectForm(current => ({ ...current, autoDeploy: previousValue }))
      setError(err instanceof Error ? err.message : 'Failed to update auto deployment')
    } finally {
      setSavingAutoDeploy(false)
    }
  }

  const handleDelete = async () => {
    if (!siteId || deleteConfirm !== project?.name) return
    setDeleting(true)
    setError(null)
    try {
      const res = await fetch(`/api/sites/${siteId}`, { method: 'DELETE' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'Application could not be removed')
      router.push('/projects?view=apps')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Application could not be removed')
      setDeleting(false)
    }
  }

  // Keep the history moving while a release is in flight.
  const deploymentInFlight = deployments.some(d => d.status === 'running' || d.status === 'queued')
  useEffect(() => {
    if (!siteId || !deploymentInFlight) return
    const timer = window.setInterval(async () => {
      if (document.hidden) return
      const response = await fetch(`/api/deployments?project_id=${encodeURIComponent(siteId)}`, { cache: 'no-store' }).catch(() => null)
      if (response?.ok) setDeployments(await response.json())
      setClock(Date.now())
    }, 3000)
    return () => window.clearInterval(timer)
  }, [siteId, deploymentInFlight])

  const handleServiceAction = async (action: 'start' | 'stop' | 'restart') => {
    if (!siteId) return
    if (action === 'stop' && !window.confirm(`Stop ${project?.name}? Visitors will not be able to reach it until you start it again.`)) return
    setActionBusy(action)
    setError(null)
    try {
      const res = await fetch(`/api/services/${siteId}/${action}`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Failed to ${action} the application`)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action}`)
    } finally {
      setActionBusy(null)
    }
  }

  const loadWebhook = async () => {
    if (!siteId) return
    setGhHookError(null)
    try {
      const [secretRes, ghRes] = await Promise.all([fetch(`/api/projects/${siteId}/webhook`), fetch(`/api/projects/${siteId}/webhook/github`)])
      if (secretRes.ok) {
        const data = await secretRes.json()
        setWebhookHasSecret(data.hasSecret)
        setWebhookSecret(data.secret)
      }
      if (ghRes.ok) setGhHookInstalled((await ghRes.json()).installed ?? false)
    } catch { /* webhook status is optional */ }
  }

  const handleGenerateSecret = async () => {
    if (!siteId) return
    setWebhookGenerating(true)
    try {
      const res = await fetch(`/api/projects/${siteId}/webhook`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to generate secret')
      setWebhookSecret(data.secret)
      setWebhookHasSecret(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate secret')
    } finally {
      setWebhookGenerating(false)
    }
  }

  const handleInstallGithubWebhook = async () => {
    if (!siteId) return
    setGhHookInstalling(true)
    setGhHookError(null)
    try {
      const res = await fetch(`/api/projects/${siteId}/webhook/github`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'Failed to install webhook')
      setGhHookInstalled(true)
    } catch (err) {
      setGhHookError(err instanceof Error ? err.message : 'Failed to install webhook on GitHub')
    } finally {
      setGhHookInstalling(false)
    }
  }

  const handleRemoveGithubWebhook = async () => {
    if (!siteId) return
    setGhHookRemoving(true)
    setGhHookError(null)
    try {
      const res = await fetch(`/api/projects/${siteId}/webhook/github`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to remove webhook')
      }
      setGhHookInstalled(false)
    } catch (err) {
      setGhHookError(err instanceof Error ? err.message : 'Failed to remove webhook from GitHub')
    } finally {
      setGhHookRemoving(false)
    }
  }

  const webhookUrl = 'https://deploy.smartcloudgh.com/api/webhooks/github'
  const handleCopyWebhook = async (type: 'url' | 'secret') => {
    const text = type === 'url' ? webhookUrl : webhookSecret
    if (!text) return
    await navigator.clipboard.writeText(text)
    setWebhookCopied(type)
    setTimeout(() => setWebhookCopied(null), 2000)
  }

  const handleClearLogs = async () => {
    if (!siteId) return
    setClearingLogs(true)
    try {
      const res = await fetch(`/api/sites/${siteId}/logs?type=${logsType}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to clear logs')
      }
      setLogs('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear logs')
    } finally {
      setClearingLogs(false)
    }
  }

  const loadNpmScripts = useCallback(async () => {
    if (!siteId) return
    try {
      const res = await fetch(`/api/sites/${siteId}/console`)
      if (res.ok) {
        const data = await res.json()
        setNpmScripts(data.scripts || {})
        setConsoleCommands(data.commands || [])
        setConsoleCwd(current => current || data.root || '')
        setNpmOutput(current => current || `Windows PowerShell\nSynergy project session\nRuntime: ${Object.entries(data.runtimeVersions || {}).map(([name, version]) => `${name} ${version}`).join(', ') || 'host defaults'}\n`)
        try {
          const saved = JSON.parse(localStorage.getItem(`manager-console-history:${siteId}`) || '[]')
          if (Array.isArray(saved)) setConsoleHistory(saved.filter((entry): entry is string => typeof entry === 'string').slice(-100))
        } catch { /* Ignore malformed browser history. */ }
      }
    } catch { /* the console stays usable without suggestions */ }
  }, [siteId])

  const runNpmCommand = async (command: string) => {
    if (!siteId || npmRunning) return
    const trimmed = command.trim()
    if (!trimmed) return
    if (/^(cls|clear)$/i.test(trimmed)) {
      setNpmOutput('')
      setNpmCommand('')
      setConsoleHistory(previous => previous[previous.length - 1] === trimmed ? previous : [...previous, trimmed].slice(-100))
      setConsoleHistoryIndex(-1)
      requestAnimationFrame(() => terminalInputRef.current?.focus())
      return
    }
    const cwd = consoleCwd || project?.root_path || ''
    const prompt = `PS ${cwd}> ${trimmed}\n`
    setConsoleHistory(previous => previous[previous.length - 1] === trimmed ? previous : [...previous, trimmed].slice(-100))
    setConsoleHistoryIndex(-1)
    setNpmCommand('')
    if (/^(history|get-history)$/i.test(trimmed)) {
      const displayedHistory = consoleHistory[consoleHistory.length - 1] === trimmed ? consoleHistory : [...consoleHistory, trimmed]
      setNpmOutput(previous => `${previous}${previous && !previous.endsWith('\n') ? '\n' : ''}${prompt}${displayedHistory.map((entry, index) => `${String(index + 1).padStart(4)}  ${entry}`).join('\n')}\n`)
      requestAnimationFrame(() => terminalInputRef.current?.focus())
      return
    }
    if (/^(pwd|get-location)$/i.test(trimmed)) {
      setNpmOutput(previous => `${previous}${previous && !previous.endsWith('\n') ? '\n' : ''}${prompt}\nPath\n----\n${cwd}\n`)
      requestAnimationFrame(() => terminalInputRef.current?.focus())
      return
    }
    setNpmRunning(true)
    setError(null)
    setNpmOutput(previous => `${previous}${previous && !previous.endsWith('\n') ? '\n' : ''}${prompt}`)
    const controller = new AbortController()
    npmAbortRef.current = controller
    try {
      const res = await fetch(`/api/sites/${siteId}/console`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: trimmed, cwd }), signal: controller.signal })
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to run command')
      }
      const nextCwd = res.headers.get('X-Console-Cwd')
      if (nextCwd) setConsoleCwd(decodeURIComponent(nextCwd))
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        setNpmOutput(prev => (prev + chunk).slice(-500000))
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') setNpmOutput(prev => prev + '\n[stopped] Command aborted by user\n')
      else setError(err instanceof Error ? err.message : 'Failed to run command')
    } finally {
      setNpmRunning(false)
      npmAbortRef.current = null
      requestAnimationFrame(() => terminalInputRef.current?.focus())
    }
  }

  useEffect(() => { if (activeTab === 'console') void loadNpmScripts() }, [activeTab, loadNpmScripts])
  useEffect(() => {
    if (siteId && consoleHistory.length) localStorage.setItem(`manager-console-history:${siteId}`, JSON.stringify(consoleHistory))
  }, [consoleHistory, siteId])
  useEffect(() => () => npmAbortRef.current?.abort(), [])
  useEffect(() => { if (npmOutputRef.current) npmOutputRef.current.scrollTop = npmOutputRef.current.scrollHeight }, [npmOutput, npmRunning])

  const stopNpmCommand = () => npmAbortRef.current?.abort()

  const completeConsoleCommand = async () => {
    const tokenMatch = npmCommand.match(/(?:^|\s)([^\s"']*)$/)
    const token = tokenMatch?.[1] || ''
    const tokenStart = npmCommand.length - token.length
    try {
      const res = await fetch(`/api/sites/${siteId}/console?cwd=${encodeURIComponent(consoleCwd || project?.root_path || '')}`)
      if (!res.ok) return
      const data = await res.json()
      const commandNames = ['cd', 'clear', 'cls', 'Get-ChildItem', 'Get-Content', 'Get-History', 'Get-Location', 'history', 'pwd', ...(data.commands || []).map((value: string) => value.split(/\s+/)[0])]
      const source: string[] = tokenStart === 0 ? commandNames : data.entries || []
      const matches = [...new Set(source)].filter(entry => entry.toLowerCase().startsWith(token.toLowerCase()))
      if (!matches.length) return
      const common = matches.reduce((prefix, entry) => {
        let length = 0
        while (length < prefix.length && length < entry.length && prefix[length].toLowerCase() === entry[length].toLowerCase()) length++
        return prefix.slice(0, length)
      })
      if (matches.length === 1 || common.length > token.length) setNpmCommand(`${npmCommand.slice(0, tokenStart)}${matches.length === 1 ? matches[0] : common}`)
      else setNpmOutput(previous => `${previous}${previous && !previous.endsWith('\n') ? '\n' : ''}${matches.join('    ')}\n`)
    } catch { /* Tab completion is best effort. */ }
  }

  const handleCancelDeployment = async (deploymentId: string) => {
    setCancellingDeploy(deploymentId)
    setError(null)
    try {
      const res = await fetch(`/api/deployments/${deploymentId}/cancel`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to cancel deployment')
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel deployment')
    } finally {
      setCancellingDeploy(null)
    }
  }

  const handleRollback = async (deployment: Deployment) => {
    if (!deployment.commit_sha) return
    const short = deployment.commit_sha.slice(0, 7)
    if (!window.confirm(`Roll back to commit ${short}? Synergy rebuilds that exact version and swaps it in once it passes its checks.`)) return
    setRollingBack(deployment.id)
    setError(null)
    try {
      const res = await fetch(`/api/deployments/${deployment.id}/rollback`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'Rollback failed')
      if (body.deploymentId) {
        router.push(`/deployments/${body.deploymentId}`)
        return
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rollback failed')
    } finally {
      setRollingBack(null)
    }
  }

  const live = useMemo(() => deployments.find(d => d.is_active) || deployments.find(d => d.status === 'success'), [deployments])
  const latest = deployments[0]

  if (loading) {
    return (
      <AppShell title="Loading application…" back={{ href: '/projects?view=apps', label: 'Projects' }}>
        <div className="space-y-4">
          <div className="h-72 animate-pulse rounded-xl border border-border bg-card" />
          <div className="h-48 animate-pulse rounded-xl border border-border bg-card" />
        </div>
      </AppShell>
    )
  }

  if (!project) {
    return (
      <AppShell title="Application not found" back={{ href: '/projects?view=apps', label: 'Projects' }}>
        <div className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">{error || 'This application does not exist or was removed.'}</div>
      </AppShell>
    )
  }

  const hasRunningDeploy = deployments.some(d => d.status === 'running')
  const visibleToolchains = toolchainRuntimes.filter(runtime =>
    runtime.id === 'node' ? ['next', 'node', 'angular', 'laravel'].includes(projectForm.projectType)
      : runtime.id === 'php' ? projectForm.projectType === 'laravel'
      : runtime.id === 'go' && projectForm.projectType === 'go')
  const primaryUrl = project.url ? (project.url.startsWith('http') ? project.url : `https://${project.url}`) : domains[0] ? `https://${domains[0]}` : null
  const address = primaryUrl?.replace(/^https?:\/\//, '') || (project.port ? `localhost:${project.port}` : null)
  // A URL set by hand in Settings counts as a public address even without a managed domain record.
  const publicHosts = domains.length ? domains : primaryUrl ? [primaryUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '')] : []
  const mainDatabase = dataServices.find(service => service.application_primary) || dataServices[0]
  const inStack = !!stack?.application_group_id
  const stackSiblings = (stack?.members || []).filter(member => member.environment === project.environment && member.id !== project.id).length
  const browserApp = project.project_type === 'angular'
  const showSetupTab = project.setup_required || activeTab === 'setup'
  const sameAsProduction = !!deployments[0]?.commit_sha && deployments[0].commit_sha === productionDeployment?.commit_sha
  const inputClass = 'control-input'

  const runtimeSwitch = (
    <div className="mb-4 flex h-8 w-fit items-center rounded-md border border-border p-0.5" role="group" aria-label="Runtime view">
      {(['logs', 'console'] as const).map(value => (
        <button key={value} type="button" onClick={() => changeTab(value)} aria-pressed={activeTab === value} className={cn('h-full rounded-[5px] px-3 text-xs', activeTab === value ? 'bg-white/[0.09] text-foreground' : 'text-muted-foreground hover:text-foreground')}>{value === 'logs' ? 'Logs' : 'Console'}</button>
      ))}
    </div>
  )

  const tabs = (
    <TabsList className="scrollbar-none h-auto min-h-0 w-full justify-start gap-0 overflow-x-auto border-0 bg-transparent p-0">
      {(showSetupTab ? ['setup'] : []).concat(['overview', 'deployments', 'environment', 'logs', 'storage', 'domains', 'settings']).map(value => (
        <TabsTrigger key={value} value={value === 'logs' && activeTab === 'console' ? 'console' : value} title={{ setup: 'Finish connecting your repository, database and domain', overview: 'Is the app running, and what can I do with it?', deployments: 'Every release and its build output', environment: 'The settings and secrets in the .env file', logs: 'What the app prints, and a terminal for running commands', storage: 'Where the app keeps its data', domains: 'The web addresses that open the app', settings: 'Name, repository, build commands, restart and remove' }[value]} className="group relative min-h-0 rounded-none border-0 px-1 pb-3 pt-1 text-[13px] font-normal text-muted-foreground data-[state=active]:text-foreground">
          <span className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 transition-colors group-hover:bg-white/[0.06]">
            {value === 'setup' && <span className="h-1.5 w-1.5 rounded-full spectrum-bar" />}
            {{ setup: 'Setup', overview: 'Overview', deployments: 'Deployments', storage: 'Databases', domains: 'Domains', environment: 'Environment', logs: 'Logs & console', settings: 'Settings' }[value]}
          </span>
          <span className="absolute inset-x-2 bottom-0 hidden h-[2px] rounded-full bg-foreground group-data-[state=active]:block" aria-hidden="true" />
        </TabsTrigger>
      ))}
    </TabsList>
  )

  return (
    <Tabs value={activeTab} onValueChange={changeTab}>
      <AppShell
        title={project.name}
        back={inStack ? { href: `/projects/${stack!.application_group_id}`, label: stack!.group_name || 'Project' } : { href: '/projects', label: 'Projects' }}
        subtitle={<span className="flex flex-wrap items-center gap-2">
          <EnvironmentBadge environment={project.environment} />
          {inStack && <Link href={`/projects/${stack!.application_group_id}`} className="flex items-center gap-1 rounded-full border border-syn-violet/30 bg-syn-violet/10 px-2 py-px text-[11px] text-violet-200 hover:bg-syn-violet/20"><Layers className="h-3 w-3" />{roleLabels[stack!.component_role]} · {stack!.group_name}</Link>}
          {repoLabel(project.repo_url) && <span className="truncate font-mono text-xs">{repoLabel(project.repo_url)}</span>}
        </span>}
        tabs={tabs}
        actions={<>
          {canWrite && !project.setup_required && <label className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground" title={project.auto_deploy ? `Deploys when you push to ${project.default_branch}` : 'Pushes are ignored; deploy manually'}>
            <Zap className={`h-3.5 w-3.5 ${project.auto_deploy ? 'text-status-ready' : ''}`} aria-hidden="true" />Auto-deploy
            <Switch checked={project.auto_deploy} disabled={savingAutoDeploy} onCheckedChange={() => void handleToggleAutoDeploy()} aria-label="Auto-deploy" />
          </label>}
          {primaryUrl && <Button asChild variant="outline" size="sm"><a href={primaryUrl} target="_blank" rel="noreferrer">Visit<ArrowUpRight className="ml-1.5 h-3.5 w-3.5" /></a></Button>}
          {project.environment === 'staging' && (
            <Button variant="outline" size="sm" onClick={() => void handlePromote()} disabled={!canWrite || promoting || sameAsProduction} title={sameAsProduction ? 'Production already runs this commit' : 'Merge into production and deploy it'}>
              <ArrowUpRight className="mr-1.5 h-3.5 w-3.5" />{promoting ? 'Promoting…' : 'Promote to production'}
            </Button>
          )}
          <Button size="sm" onClick={() => void handleDeploy()} disabled={!canWrite || deploying || hasRunningDeploy || project.setup_required} title={project.setup_required ? 'Finish setup first' : undefined}>
            {hasRunningDeploy ? <><RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />Deploying…</> : <><Rocket className="mr-1.5 h-3.5 w-3.5" />Deploy</>}
          </Button>
        </>}
      >
        {error && <div role="alert" className="notice-error">{error}</div>}

        <TabsContent value="setup" className="mt-0">
          <ProjectSetup key={project.id} projectId={project.id} onChanged={() => void refresh()} onDeploy={() => void handleDeploy()} deploying={deploying || hasRunningDeploy} />
        </TabsContent>

        <TabsContent value="overview" className="mt-0 space-y-6">
          {project.setup_required ? (
            <div className="relative overflow-hidden rounded-xl border border-border bg-black p-8">
              <div className="syn-canvas pointer-events-none absolute inset-0 opacity-70" aria-hidden="true" />
              <div className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-syn-violet/15 blur-3xl" aria-hidden="true" />
              <div className="relative flex flex-wrap items-center justify-between gap-6">
                <div className="flex items-center gap-4">
                  <FrameworkAvatar type={project.project_type} size="lg" />
                  <div><p className="text-xl font-semibold tracking-tight">Finish setting up {project.name}</p><p className="mt-1 text-sm text-muted-foreground">A few more steps (database, environment and domain), then your first deployment.</p></div>
                </div>
                <Button onClick={() => changeTab('setup')}>Continue setup<ArrowRight className="ml-1.5 h-4 w-4" /></Button>
              </div>
            </div>
          ) : (
            <section className="grid overflow-hidden rounded-xl border border-border bg-card lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="relative flex min-h-[240px] flex-col justify-between overflow-hidden border-b border-border bg-black p-6 lg:border-b-0 lg:border-r">
                <div className="syn-canvas pointer-events-none absolute inset-0 opacity-70" aria-hidden="true" />
                {hasRunningDeploy && <div className="pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-syn-violet/20 blur-3xl" aria-hidden="true" />}
                <div className="relative flex items-center gap-3">
                  <FrameworkAvatar type={project.project_type} size="lg" />
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">{projectTypeDefaults[project.project_type]?.label || project.project_type}</p>
                    {address ? (primaryUrl ? <a href={primaryUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 truncate text-lg font-semibold tracking-tight hover:underline">{address}<ArrowUpRight className="h-4 w-4 shrink-0" /></a> : <p className="truncate font-mono text-lg font-semibold">{address}</p>) : <p className="text-lg font-semibold">No address yet</p>}
                  </div>
                </div>
                <div className="relative mt-8">
                  <p className={cn('text-3xl font-semibold tracking-[-0.03em]', hasRunningDeploy && 'spectrum-text')}>
                    {hasRunningDeploy ? 'Deploying…' : !live ? 'Not deployed yet' : project.is_active ? 'Online' : 'Stopped'}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {hasRunningDeploy ? 'The current release keeps serving until the new one passes its checks.'
                      : !live ? 'Deploy to put the first release live.'
                      : project.is_active ? `Serving the release from ${relativeTime(live.finished_at, clock)}.` : 'The process is stopped, so visitors cannot reach it.'}
                  </p>
                </div>
              </div>
              <dl className="grid content-start gap-x-6 gap-y-5 p-6 text-sm sm:grid-cols-2">
                <div className="sm:col-span-2"><dt className="eyebrow">Live deployment</dt><dd>{live ? <Link href={`/deployments/${live.id}`} className="flex items-center gap-2 hover:underline"><StatusLabel status={live.status} /><span className="font-mono text-xs text-muted-foreground">{live.id.slice(0, 8)}</span></Link> : <span className="text-muted-foreground">None yet</span>}</dd></div>
                <div><dt className="eyebrow">Released</dt><dd>{live ? <>{relativeTime(live.finished_at, clock)}{live.user_name && <span className="text-muted-foreground"> by {live.user_name}</span>}</> : '—'}</dd></div>
                <div><dt className="eyebrow">Build time</dt><dd className="font-mono">{live ? formatSeconds(deploymentDuration(live.started_at, live.finished_at)) : '—'}</dd></div>
                <div className="sm:col-span-2"><dt className="eyebrow">Source</dt><dd className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="flex items-center gap-1.5"><GitBranch className="h-4 w-4 text-muted-foreground" />{live?.branch || project.default_branch}</span>
                  {live?.commit_sha && (commitUrl(project.repo_url, live.commit_sha)
                    ? <a href={commitUrl(project.repo_url, live.commit_sha)!} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 font-mono hover:underline"><GitCommitHorizontal className="h-4 w-4 text-muted-foreground" />{live.commit_sha.slice(0, 7)}</a>
                    : <span className="flex items-center gap-1.5 font-mono"><GitCommitHorizontal className="h-4 w-4 text-muted-foreground" />{live.commit_sha.slice(0, 7)}</span>)}
                </dd></div>
                <div className="flex flex-wrap gap-2 sm:col-span-2">
                  {live && <Button asChild variant="outline" size="sm"><Link href={`/deployments/${live.id}`}>Build logs</Link></Button>}
                  <Button variant="outline" size="sm" onClick={() => changeTab('logs')}>Runtime logs</Button>
                  <Button variant="outline" size="sm" onClick={() => changeTab('deployments')}>All deployments</Button>
                </div>
              </dl>
            </section>
          )}

          <Section title="At a glance" description="How this application is running, in plain language.">
            <div className="divide-y divide-border">
              <StatusLine tone={project.is_active ? 'ok' : 'off'} icon={<Activity className="h-3.5 w-3.5" />}
                action={canWrite && live ? (project.is_active
                  ? <Button variant="ghost" size="sm" onClick={() => void handleServiceAction('restart')} disabled={actionBusy !== null}><RotateCw className={cn('mr-1.5 h-3.5 w-3.5', actionBusy === 'restart' && 'animate-spin')} />Restart</Button>
                  : <Button variant="outline" size="sm" onClick={() => void handleServiceAction('start')} disabled={actionBusy !== null}><Play className="mr-1.5 h-3.5 w-3.5" />Start</Button>) : undefined}>
                {project.is_active ? <><span className="font-medium">Running</span><span className="text-muted-foreground"> on port {project.port ?? '—'} as process <span className="font-mono">{project.pm2_name}</span></span></> : <><span className="font-medium">Not running</span><span className="text-muted-foreground"> — {live ? 'start it to serve visitors again' : 'it starts with the first deployment'}</span></>}
              </StatusLine>
              <StatusLine tone={publicHosts.length ? 'ok' : 'warn'} icon={<Globe2 className="h-3.5 w-3.5" />}
                action={<Button variant="ghost" size="sm" onClick={() => changeTab('domains')}>{publicHosts.length ? 'Manage' : 'Add domain'}</Button>}>
                {publicHosts.length ? <><span className="font-medium">Public at </span><a href={`https://${publicHosts[0]}`} target="_blank" rel="noreferrer" className="hover:underline">{publicHosts[0]}</a>{publicHosts.length > 1 && <span className="text-muted-foreground"> and {publicHosts.length - 1} more</span>}</> : <><span className="font-medium">No public domain</span><span className="text-muted-foreground"> — only reachable from the server{project.port ? ` at localhost:${project.port}` : ''}</span></>}
              </StatusLine>
              <StatusLine tone={browserApp ? 'info' : mainDatabase ? 'ok' : 'off'} icon={<Database className="h-3.5 w-3.5" />}
                action={!browserApp ? <Button variant="ghost" size="sm" onClick={() => changeTab('storage')}>{mainDatabase ? 'Manage' : 'Add database'}</Button> : undefined}>
                {browserApp ? <><span className="font-medium">Browser app</span><span className="text-muted-foreground"> — gets its data from a backend API</span></>
                  : mainDatabase ? <><span className="font-medium">Stores data in </span><span className="font-mono">{mainDatabase.database_name}</span><span className="text-muted-foreground"> ({providerMeta[mainDatabase.provider]?.label}{mainDatabase.shared_from_project_name ? `, shared from ${mainDatabase.shared_from_project_name}` : ''}){dataServices.length > 1 ? ` and ${dataServices.length - 1} more` : ''}</span></>
                  : <><span className="font-medium">No database</span><span className="text-muted-foreground"> connected</span></>}
              </StatusLine>
              <StatusLine tone={project.auto_deploy ? 'ok' : 'off'} icon={<Zap className="h-3.5 w-3.5" />}
                action={canWrite ? <Switch checked={project.auto_deploy} disabled={savingAutoDeploy || project.setup_required} onCheckedChange={() => void handleToggleAutoDeploy()} aria-label="Automatic deployments" /> : undefined}>
                {project.auto_deploy ? <><span className="font-medium">Deploys automatically</span><span className="text-muted-foreground"> when you push to <span className="font-mono">{project.default_branch}</span></span></> : <><span className="font-medium">Manual deploys only</span><span className="text-muted-foreground"> — pushes to <span className="font-mono">{project.default_branch}</span> are ignored</span></>}
              </StatusLine>
              <StatusLine tone={inStack ? 'info' : 'off'} icon={<Layers className="h-3.5 w-3.5" />}>
                {inStack ? <><span className="font-medium">{roleLabels[stack!.component_role]}</span><span className="text-muted-foreground"> of the {stack!.group_name} project, with {stackSiblings} other {stackSiblings === 1 ? 'app' : 'apps'}</span></> : <><span className="font-medium">Standalone</span><span className="text-muted-foreground"> — the only app in its project</span></>}
              </StatusLine>
              {latest && (
                <StatusLine tone={latest.status === 'failed' ? 'warn' : latest.status === 'success' ? 'ok' : 'info'} icon={<Rocket className="h-3.5 w-3.5" />}
                  action={<Button asChild variant="ghost" size="sm"><Link href={`/deployments/${latest.id}`}>View</Link></Button>}>
                  <span className="font-medium">Last deployment {latest.status === 'success' ? 'succeeded' : latest.status === 'failed' ? 'failed' : latest.status === 'running' ? 'is running' : 'is queued'}</span>
                  <span className="text-muted-foreground"> {relativeTime(latest.started_at, clock)}{latest.status === 'failed' && live ? ' — the previous release is still live' : ''}</span>
                </StatusLine>
              )}
            </div>
          </Section>

          <StackPanel key={project.id} projectId={project.id} environment={project.environment} />

          <Section title="Everything for this app" description="Each part of this app has its own tab. Here is what each one is for, in plain words.">
            <AppToolGrid appId={project.id} onSelect={tab => changeTab(tab)} />
            {(project.staging_id || project.production_id) && (
              <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
                {project.staging_id && <Button asChild variant="outline" size="sm"><Link href={`/sites/${project.staging_id}`}><GitBranch className="mr-1.5 h-3.5 w-3.5" />Open the staging version<ArrowRight className="ml-1.5 h-3.5 w-3.5" /></Link></Button>}
                {project.production_id && <Button asChild variant="outline" size="sm"><Link href={`/sites/${project.production_id}`}><Rocket className="mr-1.5 h-3.5 w-3.5" />Open the production version<ArrowRight className="ml-1.5 h-3.5 w-3.5" /></Link></Button>}
              </div>
            )}
          </Section>
        </TabsContent>

        <TabsContent value="deployments" className="mt-0 space-y-4">
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {deployments.length === 0 ? (
              <div className="px-6 py-14 text-center">
                <Rocket className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
                <p className="text-sm font-medium">No deployments yet</p>
                <p className="mt-1 text-xs text-muted-foreground">{project.setup_required ? 'Finish setup, then deploy to create the first release.' : 'Deploy to create the first release.'}</p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {deployments.map(d => (
                  <DeploymentRow key={d.id} deployment={{ ...d, project_name: project.name }} now={clock} showProject={false}
                    actions={<>
                      {d.status === 'success' && !d.is_active && d.commit_sha && !hasRunningDeploy && canWrite && (
                        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => void handleRollback(d)} disabled={rollingBack !== null}>{rollingBack === d.id ? 'Rolling back…' : 'Roll back'}</Button>
                      )}
                      {d.status === 'running' && canWrite && (
                        <Button variant="outline" size="sm" className="h-7 px-2 text-xs text-red-300" onClick={() => void handleCancelDeployment(d.id)} disabled={cancellingDeploy === d.id}>{cancellingDeploy === d.id ? 'Cancelling…' : 'Cancel'}</Button>
                      )}
                    </>} />
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="storage" className="mt-0">
          <StoragePanel projectId={project.id} projectName={project.name} projectType={project.project_type} role={userRole} onChanged={() => void refresh()} />
        </TabsContent>

        <TabsContent value="domains" className="mt-0">
          <DomainsPanel projectId={project.id} projectName={project.name} port={project.port} environment={project.environment} role={userRole} onChanged={() => void refresh()} />
        </TabsContent>

        <TabsContent value="environment" className="mt-0 space-y-4">
          <Section
            title="Environment variables"
            description={<>These are the settings and secrets your app reads when it starts, such as a database address, an API key or a mail password. They are saved in the app&apos;s <span className="font-mono text-xs">.env</span> file on this server. Changes apply on the next deployment or restart. Database variables are added for you and don&apos;t need to be listed here.</>}
            action={<div className="flex h-8 items-center rounded-md border border-border p-0.5" role="group" aria-label="File">
              {['.env', '.env.local'].map(file => <button key={file} type="button" onClick={() => setEnvFile(file)} aria-pressed={envFile === file} className={cn('h-full rounded-[5px] px-2.5 font-mono text-xs', envFile === file ? 'bg-white/[0.09] text-foreground' : 'text-muted-foreground hover:text-foreground')}>{file}</button>)}
            </div>}
            footer={<>
              <span>{browserApp ? 'Browser builds expose these values to visitors. Never store secrets here.' : 'Stored only on this server, inside the application directory.'}</span>
              <Button size="sm" onClick={() => void handleSaveEnv()} disabled={savingEnv || !canWrite}>{envSaved ? <><Check className="mr-1.5 h-3.5 w-3.5" />Saved</> : savingEnv ? 'Saving…' : 'Save'}</Button>
            </>}
          >
            <div className="overflow-hidden rounded-lg border border-border">
              <EnvEditor className="h-[28rem] rounded-none border-0" value={envContent} onChange={setEnvContent} placeholder={`# ${envFile}\nKEY=value`} />
            </div>
          </Section>
          <Section title="How it's built" description="What Synergy runs on every deployment." action={<Button variant="outline" size="sm" onClick={() => changeTab('settings')}>Edit</Button>}>
            <dl className="summary-list">
              <div><dt>Framework</dt><dd>{projectTypeDefaults[project.project_type]?.label}</dd></div>
              {project.deploy_script
                ? <div><dt>Deployment script</dt><dd><pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5">{project.deploy_script}</pre></dd></div>
                : <>
                  <div><dt>Install</dt><dd className="font-mono text-xs">{project.install_cmd ?? projectTypeDefaults[project.project_type]?.installCmd ?? 'Automatic from the lockfile'}</dd></div>
                  <div><dt>Build</dt><dd className="font-mono text-xs">{project.build_cmd ?? projectTypeDefaults[project.project_type]?.buildCmd ?? 'None'}</dd></div>
                </>}
              <div><dt>Start</dt><dd className="font-mono text-xs">{project.start_cmd ?? projectTypeDefaults[project.project_type]?.startCmd ?? 'Synergy static server'}</dd></div>
            </dl>
          </Section>
        </TabsContent>

        <TabsContent value="logs" className="mt-0">
          {runtimeSwitch}
          <Section
            title="Logs"
            description={<>What the app prints while it runs. When something is not working, look here first. This is the live output from the running process{logsPath && <> · <span className="font-mono text-xs">{logsPath}</span></>}</>}
            action={<>
              <div className="flex h-8 items-center rounded-md border border-border p-0.5" role="group" aria-label="Log stream">
                {(['out', 'err'] as const).map(type => <button key={type} type="button" onClick={() => setLogsType(type)} aria-pressed={logsType === type} className={cn('h-full rounded-[5px] px-2.5 text-xs', logsType === type ? 'bg-white/[0.09] text-foreground' : 'text-muted-foreground hover:text-foreground')}>{type === 'out' ? 'Output' : 'Errors'}</button>)}
              </div>
              <Button variant="outline" size="sm" onClick={() => void handleClearLogs()} disabled={clearingLogs || !canWrite}>{clearingLogs ? 'Clearing…' : 'Clear'}</Button>
            </>}
          >
            <div className="h-[520px] overflow-y-auto rounded-lg border border-border bg-black p-4 font-mono text-xs leading-5">
              {logs ? renderLogLines(logs) : <p className="py-10 text-center text-white/40">{logsStatus || 'No output yet. Logs appear once the app is running.'}</p>}
            </div>
          </Section>
        </TabsContent>

        <TabsContent value="console" className="mt-0 space-y-4">
          {runtimeSwitch}
          <Section title="Console" description={<>A terminal for one-off commands, such as running database migrations or an npm script. It opens inside <span className="break-all font-mono text-xs">{project.root_path}</span> with this app&apos;s runtime versions and environment.</>}>
            {(consoleCommands.length > 0 || Object.keys(npmScripts).length > 0) && (
              <div className="mb-4 flex flex-wrap gap-2">
                {consoleCommands.map(cmd => <Button key={cmd} variant="outline" size="sm" className="font-mono text-xs" disabled={npmRunning || !canWrite} onClick={() => { setNpmCommand(cmd); void runNpmCommand(cmd) }}>{cmd}</Button>)}
                {Object.entries(npmScripts).map(([name, script]) => <Button key={name} variant="secondary" size="sm" className="font-mono text-xs" disabled={npmRunning || !canWrite} title={script} onClick={() => { setNpmCommand(`npm run ${name}`); void runNpmCommand(`npm run ${name}`) }}><Play className="mr-1.5 h-3 w-3" />{name}</Button>)}
              </div>
            )}
            <div className="overflow-hidden rounded-lg border border-border bg-black">
              <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                <span className="flex min-w-0 items-center gap-2 truncate font-mono text-xs text-muted-foreground"><Terminal className="h-3.5 w-3.5" />PowerShell · {project.name}</span>
                <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1.5"><span className={cn('h-1.5 w-1.5 rounded-full', npmRunning ? 'animate-pulse bg-status-building' : 'bg-status-ready')} />{npmRunning ? 'running' : 'ready'}</span>
                  {npmOutput && <button onClick={async () => { await navigator.clipboard.writeText(npmOutput); setConsoleCopied(true); setTimeout(() => setConsoleCopied(false), 1200) }} className="flex items-center gap-1 hover:text-foreground">{consoleCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}{consoleCopied ? 'Copied' : 'Copy'}</button>}
                  {npmOutput && !npmRunning && <button onClick={() => { setNpmOutput(''); requestAnimationFrame(() => terminalInputRef.current?.focus()) }} className="hover:text-foreground">Clear</button>}
                </div>
              </div>
              <div ref={npmOutputRef} className="h-[480px] cursor-text overflow-y-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5 text-[#d6d6d6]" onClick={() => terminalInputRef.current?.focus()}>
                {npmOutput && renderLogLines(npmOutput)}
                <div className="mt-1 flex min-h-7 items-start gap-2 text-[13px] leading-7">
                  <span className="shrink-0 font-semibold text-white">PS</span>
                  <span className="shrink-0 text-syn-cyan">{consoleCwd || project.root_path}</span>
                  <span className="shrink-0 font-semibold text-white">&gt;</span>
                  <input
                    ref={terminalInputRef}
                    className="min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-[13px] leading-7 text-white caret-white outline-none"
                    value={npmCommand}
                    onChange={e => setNpmCommand(e.target.value)}
                    onKeyDown={e => {
                      if (e.ctrlKey && e.key.toLowerCase() === 'c' && npmRunning) { e.preventDefault(); stopNpmCommand(); return }
                      if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); setNpmOutput(''); return }
                      if (e.ctrlKey && e.key.toLowerCase() === 'u') { e.preventDefault(); setNpmCommand(''); return }
                      if (e.key === 'Escape') { e.preventDefault(); setNpmCommand(''); setConsoleHistoryIndex(-1); return }
                      if (e.key === 'Tab' && !npmRunning) { e.preventDefault(); void completeConsoleCommand(); return }
                      if (e.key === 'ArrowUp') { e.preventDefault(); const index = Math.min(consoleHistory.length - 1, consoleHistoryIndex + 1); if (index >= 0) { setConsoleHistoryIndex(index); setNpmCommand(consoleHistory[consoleHistory.length - 1 - index]) } return }
                      if (e.key === 'ArrowDown') { e.preventDefault(); const index = consoleHistoryIndex - 1; setConsoleHistoryIndex(index); setNpmCommand(index >= 0 ? consoleHistory[consoleHistory.length - 1 - index] : ''); return }
                      if (e.key === 'Enter' && !npmRunning) void runNpmCommand(npmCommand)
                    }}
                    aria-label="Console command"
                    readOnly={npmRunning || !canWrite}
                    placeholder={!canWrite ? 'Viewers cannot run commands' : npmRunning ? 'Command is running…' : ''}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {npmRunning && <button onClick={e => { e.stopPropagation(); stopNpmCommand() }} className="mt-0.5 flex shrink-0 items-center gap-1.5 rounded-md bg-red-500/15 px-2.5 py-1 text-xs leading-5 text-red-300 hover:bg-red-500/25"><Square className="h-3 w-3" />Stop</button>}
                </div>
              </div>
              <p className="border-t border-border px-4 py-2 font-mono text-[10px] text-muted-foreground">Tab completes · ↑↓ history · Ctrl+C stops · Ctrl+L clears</p>
            </div>
          </Section>
        </TabsContent>

        <TabsContent value="settings" className="mt-0 space-y-6">
          <Section title="General" description="Name, framework and where the code comes from."
            footer={<><span>Changes apply on the next deployment.</span><Button size="sm" onClick={() => void handleSaveProject()} disabled={savingProject || !canWrite}>{projectSaved ? <><Check className="mr-1.5 h-3.5 w-3.5" />Saved</> : savingProject ? 'Saving…' : 'Save'}</Button></>}>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="field-label">Application name<input className={inputClass} value={projectForm.name} onChange={e => setProjectForm({ ...projectForm, name: e.target.value })} /></label>
              <label className="field-label">Framework<select className={inputClass} value={projectForm.projectType} onChange={e => {
                const projectType = e.target.value as ProjectType
                const defaults = projectTypeDefaults[projectType]
                setProjectForm({ ...projectForm, projectType, installCmd: defaults.installCmd ?? '', buildCmd: defaults.buildCmd ?? '', startCmd: defaults.startCmd ?? '' })
              }}>{Object.entries(projectTypeDefaults).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}</select></label>
              <label className="field-label">Repository<input className={cn(inputClass, 'font-mono text-xs')} value={projectForm.repoUrl} onChange={e => setProjectForm({ ...projectForm, repoUrl: e.target.value })} placeholder="https://github.com/org/repo" /></label>
              <label className="field-label">Branch<input className={cn(inputClass, 'font-mono')} value={projectForm.defaultBranch} onChange={e => setProjectForm({ ...projectForm, defaultBranch: e.target.value })} placeholder="main" /></label>
              <label className="field-label md:col-span-2">GitHub account<select className={inputClass} value={projectForm.githubConnectionId} onChange={e => setProjectForm({ ...projectForm, githubConnectionId: e.target.value })}>
                <option value="">Legacy default connection</option>
                {githubConnections.map(connection => <option key={connection.id} value={connection.id}>{connection.name} (@{connection.account_login})</option>)}
              </select></label>
            </div>
          </Section>

          <Section title="Git & automatic deploys" description={project.environment === 'staging' ? `Pushes to ${project.default_branch} deploy this staging copy. The GitHub webhook is managed on the production application.` : 'Connect a GitHub webhook so pushes trigger deployments.'}>
            <div className="space-y-4">
              <label className="flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3 text-sm">
                <span><span className="block font-medium">Deploy on every push</span><span className="block text-xs text-muted-foreground">To <span className="font-mono">{project.default_branch}</span></span></span>
                <Switch checked={project.auto_deploy} disabled={!canWrite || savingAutoDeploy || project.setup_required} onCheckedChange={() => void handleToggleAutoDeploy()} aria-label="Deploy on every push" />
              </label>
              {project.environment === 'staging' ? (
                project.production_id && <Button asChild variant="outline" size="sm"><Link href={`/sites/${project.production_id}?tab=settings`}>Open production webhook settings<ArrowUpRight className="ml-1.5 h-3.5 w-3.5" /></Link></Button>
              ) : !webhookHasSecret ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-border px-4 py-4 text-sm">
                  <span className="text-muted-foreground">No webhook yet. Generate a secret to connect GitHub.</span>
                  <Button size="sm" onClick={() => void handleGenerateSecret()} disabled={webhookGenerating || !canWrite}>{webhookGenerating ? 'Generating…' : 'Set up webhook'}</Button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className={cn('flex items-center justify-between rounded-lg border px-4 py-3', ghHookInstalled ? 'border-status-ready/30 bg-status-ready/5' : 'border-border')}>
                    <span className="flex items-center gap-2 text-sm"><span className={cn('h-2 w-2 rounded-full', ghHookInstalled ? 'bg-status-ready' : 'bg-white/25')} />{ghHookInstalled === null ? 'Checking GitHub…' : ghHookInstalled ? 'Connected to GitHub' : 'Not connected to GitHub'}</span>
                    {ghHookInstalled
                      ? <Button variant="ghost" size="sm" onClick={() => void handleRemoveGithubWebhook()} disabled={ghHookRemoving || !canWrite}>{ghHookRemoving ? 'Removing…' : 'Disconnect'}</Button>
                      : <Button size="sm" onClick={() => void handleInstallGithubWebhook()} disabled={ghHookInstalling || !canWrite}>{ghHookInstalling ? 'Connecting…' : 'Connect'}</Button>}
                  </div>
                  {ghHookError && <p className="rounded-md border border-red-500/20 bg-red-500/10 p-2 text-xs text-red-300">{ghHookError}</p>}
                  <details className="group rounded-lg border border-border">
                    <summary className="cursor-pointer select-none px-4 py-2.5 text-xs text-muted-foreground hover:text-foreground">Manual webhook values</summary>
                    <div className="space-y-3 border-t border-border p-4">
                      {([['url', 'Payload URL', webhookUrl], ['secret', 'Secret', webhookSecret || '••••••••••••••••']] as const).map(([key, label, value]) => (
                        <label key={key} className="field-label">{label}<div className="flex gap-2"><code className="flex-1 truncate rounded-md border border-border bg-black px-3 py-2 text-xs">{value}</code><Button size="icon" variant="outline" className="h-9 w-9 shrink-0" onClick={() => void handleCopyWebhook(key)} aria-label={`Copy ${label}`}>{webhookCopied === key ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}</Button></div></label>
                      ))}
                    </div>
                  </details>
                </div>
              )}
            </div>
          </Section>

          <Section title="Build & runtime" description="Override how the app is built and started. Leave fields empty to use the framework defaults."
            footer={<><span>Commands run from the app directory and stop at the first failure. <code className="font-mono text-xs">$BRANCH</code> is the deployed branch.</span><Button size="sm" onClick={() => void handleSaveProject()} disabled={savingProject || !canWrite}>{savingProject ? 'Saving…' : 'Save'}</Button></>}>
            <div className="space-y-4">
              <label className="field-label">Deployment script <span className="font-normal text-muted-foreground">Replaces install and build when set</span>
                <textarea rows={10} className="control-textarea min-h-56 bg-black font-mono" value={projectForm.deployScript} onChange={e => setProjectForm({ ...projectForm, deployScript: e.target.value })} placeholder={'composer install --no-interaction --prefer-dist --optimize-autoloader\nphp artisan migrate --force\nnpm ci\nnpm run build'} spellCheck={false} />
              </label>
              <label className="field-label">Start command<input className={cn(inputClass, 'font-mono')} value={projectForm.startCmd} onChange={e => setProjectForm({ ...projectForm, startCmd: e.target.value })} placeholder={projectTypeDefaults[projectForm.projectType].startCmd ?? 'Synergy static server'} /></label>
              {visibleToolchains.length > 0 && <>
                <div className="grid gap-3 md:grid-cols-2">
                  {visibleToolchains.map(runtime => <label key={runtime.id} className="field-label">{runtime.name} version<select className={inputClass} value={projectForm.runtimeVersions[runtime.id] || ''} onChange={e => setProjectForm({ ...projectForm, runtimeVersions: { ...projectForm.runtimeVersions, [runtime.id]: e.target.value || undefined } })}><option value="">Server default</option>{runtime.installedVersions.map(version => <option key={version} value={version}>{version}</option>)}</select></label>)}
                </div>
                <details className="rounded-lg border border-border">
                  <summary className="cursor-pointer select-none px-4 py-2.5 text-xs text-muted-foreground hover:text-foreground">Install another runtime version</summary>
                  <div className="border-t border-border p-4"><RuntimeManager isAdmin={userRole === 'admin'} runtimeIds={visibleToolchains.map(runtime => runtime.id)} onChanged={loadToolchainRuntimes} /></div>
                </details>
              </>}
            </div>
          </Section>

          <Section title="Server" description="Where the app lives on this machine. Change these only if you know you need to."
            footer={<><span>Changing the port updates its domains at the next deployment.</span><Button size="sm" onClick={() => void handleSaveProject()} disabled={savingProject || !canWrite}>{savingProject ? 'Saving…' : 'Save'}</Button></>}>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="field-label">Directory<input className={cn(inputClass, 'font-mono text-xs')} value={projectForm.rootPath} onChange={e => setProjectForm({ ...projectForm, rootPath: e.target.value })} /></label>
              <label className="field-label">Process name<input className={cn(inputClass, 'font-mono')} value={projectForm.pm2Name} onChange={e => setProjectForm({ ...projectForm, pm2Name: e.target.value })} /></label>
              <label className="field-label">Port<input className={cn(inputClass, 'font-mono')} type="number" value={projectForm.port} onChange={e => setProjectForm({ ...projectForm, port: e.target.value })} /></label>
              <label className="field-label">Public URL<input className={inputClass} value={projectForm.url} onChange={e => setProjectForm({ ...projectForm, url: e.target.value })} placeholder="Set by the primary domain" /></label>
            </div>
            {canWrite && project.is_active && <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4 text-sm"><span className="mr-auto text-muted-foreground">Process</span>
              <Button variant="outline" size="sm" onClick={() => void handleServiceAction('restart')} disabled={actionBusy !== null}><RotateCw className={cn('mr-1.5 h-3.5 w-3.5', actionBusy === 'restart' && 'animate-spin')} />Restart</Button>
              <Button variant="outline" size="sm" className="text-red-300" onClick={() => void handleServiceAction('stop')} disabled={actionBusy !== null}><Square className="mr-1.5 h-3.5 w-3.5" />Stop</Button>
            </div>}
          </Section>

          {showSetupTab ? null : <Section title="Setup wizard" description="Walk through source, build, database, environment and domain again." action={<Button variant="outline" size="sm" onClick={() => changeTab('setup')}>Open setup</Button>} />}

          {userRole === 'admin' && (
            <Section tone="danger" title="Remove application" description={<>Removes {project.name} from Synergy, including its deployment history and domain records. The running process and the files in <span className="font-mono text-xs">{project.root_path}</span> stay on the server.</>}
              footer={<>
                <input className="control-input h-8 max-w-xs text-xs" value={deleteConfirm} onChange={e => setDeleteConfirm(e.target.value)} placeholder={`Type ${project.name} to confirm`} aria-label="Confirm application name" />
                <Button variant="destructive" size="sm" onClick={() => void handleDelete()} disabled={deleting || deleteConfirm !== project.name}><Trash2 className="mr-1.5 h-3.5 w-3.5" />{deleting ? 'Removing…' : 'Remove'}</Button>
              </>} />
          )}
        </TabsContent>
      </AppShell>
    </Tabs>
  )
}
