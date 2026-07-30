'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import {
  Plus,
  RefreshCw,
  Rocket,
  Play,
  Square,
  RotateCw,
  Activity,
  ChevronLeft,
  Settings as SettingsIcon,
  Terminal,
  Database,
  Globe,
  ArrowUpRight
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { AppShell } from '@/components/layout/app-shell'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { EnvEditor } from '@/components/env-editor'

interface Project {
  id: string
  name: string
  slug: string
  repo_url: string | null
  default_branch: string
  project_type: 'next' | 'angular' | 'go' | 'laravel' | 'node'
  root_path: string
  pm2_name: string
  install_cmd?: string | null
  build_cmd?: string | null
  start_cmd?: string | null
  pre_deploy_cmd?: string | null
  post_deploy_cmd?: string | null
  port: number | null
  url: string | null
  is_active: boolean
  environment: 'production' | 'staging'
  production_id: string | null
  staging_id: string | null
  staging_name: string | null
  production_name: string | null
}

interface Deployment {
  id: string
  project_id: string
  status: 'queued' | 'running' | 'success' | 'failed'
  branch: string | null
  commit_sha: string | null
  started_at: string | null
  finished_at: string | null
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

export default function SitePage() {
  const params = useParams()
  const router = useRouter()
  const siteId = Array.isArray(params.id) ? params.id[0] : params.id
  const [project, setProject] = useState<Project | null>(null)
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [productionDeployment, setProductionDeployment] = useState<Deployment | null>(null)
  const [loading, setLoading] = useState(true)
  const [deploying, setDeploying] = useState(false)
  const [promoting, setPromoting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [envFile, setEnvFile] = useState('.env')
  const [envContent, setEnvContent] = useState('')
  const [savingEnv, setSavingEnv] = useState(false)
  const [logsType, setLogsType] = useState<'out' | 'err'>('out')
  const [logs, setLogs] = useState('')
  const [logsPath, setLogsPath] = useState('')
  const [logsStatus, setLogsStatus] = useState<string | null>(null)
  const [panel, setPanel] = useState<'logs' | 'env' | 'settings' | 'deployments' | 'webhook'>('logs')
  const [selectedDeployment, setSelectedDeployment] = useState<Deployment | null>(null)
  const [deploymentLog, setDeploymentLog] = useState('')
  const [loadingDeploymentLog, setLoadingDeploymentLog] = useState(false)
  const deployLogRef = useRef<HTMLDivElement>(null)
  const deployStreamRef = useRef<EventSource | null>(null)
  const [editing, setEditing] = useState(false)
  const [savingProject, setSavingProject] = useState(false)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [projectForm, setProjectForm] = useState({
    name: '',
    projectType: 'next' as ProjectType,
    repoUrl: '',
    defaultBranch: '',
    rootPath: '',
    pm2Name: '',
    port: '',
    url: '',
    installCmd: '',
    buildCmd: '',
    startCmd: '',
    preDeployCmd: '',
    postDeployCmd: '',
  })
  const [webhookSecret, setWebhookSecret] = useState<string | null>(null)
  const [webhookHasSecret, setWebhookHasSecret] = useState(false)
  const [webhookLoading, setWebhookLoading] = useState(false)
  const [webhookGenerating, setWebhookGenerating] = useState(false)
  const [webhookCopied, setWebhookCopied] = useState<'url' | 'secret' | null>(null)
  const [ghHookInstalled, setGhHookInstalled] = useState<boolean | null>(null)
  const [ghHookInstalling, setGhHookInstalling] = useState(false)
  const [ghHookRemoving, setGhHookRemoving] = useState(false)
  const [ghHookError, setGhHookError] = useState<string | null>(null)
  const [clearingLogs, setClearingLogs] = useState(false)
  const [npmScripts, setNpmScripts] = useState<Record<string, string>>({})
  const [npmCommand, setNpmCommand] = useState('')
  const [npmOutput, setNpmOutput] = useState('')
  const [npmRunning, setNpmRunning] = useState(false)
  const npmAbortRef = useRef<AbortController | null>(null)
  const npmOutputRef = useRef<HTMLDivElement>(null)
  const [cancellingDeploy, setCancellingDeploy] = useState<string | null>(null)
  const [rollingBack, setRollingBack] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const [projectRes, deploymentsRes] = await Promise.all([
        fetch(`/api/sites/${siteId}`),
        fetch('/api/deployments'),
      ])
      if (!projectRes.ok) throw new Error('Failed to load site')
      if (!deploymentsRes.ok) throw new Error('Failed to load deployments')

      const projectData = await projectRes.json()
      const deploymentsData = await deploymentsRes.json()
      if (projectData.environment === 'staging' && projectData.production_id) {
        // Fetch latest successful production deployment to compare
        try {
          const prodRes = await fetch(`/api/deployments?project_id=${projectData.production_id}&status=success&limit=1`)
          if (prodRes.ok) {
            const prodData = await prodRes.json()
            if (prodData.length > 0) {
              setProductionDeployment(prodData[0])
            }
          }
        } catch {
          // ignore
        }
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
        installCmd: projectData.install_cmd || 'npm install',
        buildCmd: projectData.build_cmd || 'npm run build',
        startCmd: projectData.start_cmd || 'npm start',
        preDeployCmd: projectData.pre_deploy_cmd || '',
        postDeployCmd: projectData.post_deploy_cmd || '',
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [siteId])

  const loadEnv = useCallback(async (file: string) => {
    setError(null)
    try {
      const res = await fetch(`/api/sites/${siteId}/env?file=${encodeURIComponent(file)}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to load env file')
      }
      const data = await res.json()
      setEnvContent(data.content || '')
    } catch (err) {
      setEnvContent('')
      setError(err instanceof Error ? err.message : 'Failed to load env file')
    }
  }, [siteId])

  useEffect(() => {
    if (!siteId) return
    void refresh()
  }, [siteId, refresh])

  useEffect(() => {
    if (!siteId) return
    void loadEnv(envFile)
  }, [envFile, siteId, loadEnv])

  useEffect(() => {
    if (!siteId) return
    setLogsStatus('Connecting…')
    const eventSource = new EventSource(
      `/api/sites/${siteId}/logs/stream?type=${logsType}&lines=200`
    )
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        setLogs(data.log || '')
        setLogsPath(data.logPath || '')
        setLogsStatus(null)
      } catch {
        // ignore
      }
    }
    eventSource.onerror = () => {
      eventSource.close()
      setLogsStatus('Stream unavailable. Loading snapshot…')
      fetch(`/api/sites/${siteId}/logs?type=${logsType}&lines=200`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!data) return
          setLogs(data.log || '')
          setLogsPath(data.logPath || '')
          setLogsStatus(data.log ? null : 'No logs available.')
        })
        .catch(() => {
          setLogsStatus('Unable to load logs.')
        })
    }
    return () => eventSource.close()
  }, [logsType, siteId])

  const handleDeploy = async () => {
    if (!siteId) return
    setDeploying(true)
    setError(null)
    try {
      const res = await fetch(`/api/sites/${siteId}/deploy`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Deployment failed')
      }
      const body = await res.json().catch(() => ({}))
      await refresh()
      // Auto-switch to deployments panel and stream the new deployment
      setPanel('deployments')
      if (body.deploymentId) {
        const newDep: Deployment = {
          id: body.deploymentId,
          project_id: siteId!,
          status: 'running',
          branch: null,
          commit_sha: null,
          started_at: new Date().toISOString(),
          finished_at: null,
        }
        void handleSelectDeployment(newDep)
      }
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
      if (!res.ok) {
        throw new Error(body.error || 'Promotion failed')
      }
      // Navigate to the production site page
      if (body.productionId) {
        router.push(`/sites/${body.productionId}`)
      } else {
        await refresh()
      }
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
      const res = await fetch(`/api/sites/${siteId}/env`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: envFile, content: envContent }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to save env file')
      }
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
        startCmd: projectForm.startCmd.trim() || null,
        preDeployCmd: projectForm.preDeployCmd.trim() || null,
        postDeployCmd: projectForm.postDeployCmd.trim() || null,
      }
      const res = await fetch(`/api/sites/${siteId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to save site settings')
      }
      setEditing(false)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save project')
    } finally {
      setSavingProject(false)
    }
  }

  const closeDeployStream = useCallback(() => {
    if (deployStreamRef.current) {
      deployStreamRef.current.close()
      deployStreamRef.current = null
    }
  }, [])

  const handleSelectDeployment = useCallback(async (deployment: Deployment) => {
    closeDeployStream()
    setSelectedDeployment(deployment)
    setDeploymentLog('')
    setLoadingDeploymentLog(true)

    if (deployment.status === 'running') {
      // Stream live logs via SSE
      const es = new EventSource(`/api/deployments/${deployment.id}/stream`)
      deployStreamRef.current = es
      const depId = deployment.id
      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          setDeploymentLog(data.log || '')
          setLoadingDeploymentLog(false)
          if (data.status && data.status !== 'running') {
            es.close()
            deployStreamRef.current = null
            // Update the selected deployment status in-place
            setSelectedDeployment((prev) =>
              prev?.id === depId ? { ...prev, status: data.status } : prev
            )
            // Update the deployment in the list so badge updates immediately
            setDeployments((prev) =>
              prev.map((d) => d.id === depId ? { ...d, status: data.status } : d)
            )
          }
        } catch {
          // ignore parse errors
        }
      }
      es.onerror = () => {
        es.close()
        deployStreamRef.current = null
        setLoadingDeploymentLog(false)
      }
    } else {
      // One-shot fetch for completed deployments
      try {
        const res = await fetch(`/api/deployments/${deployment.id}`)
        if (!res.ok) return
        const data = await res.json()
        setDeploymentLog(data.log || '')
      } catch {
        // ignore
      } finally {
        setLoadingDeploymentLog(false)
      }
    }
  }, [closeDeployStream])

  // Cleanup stream on unmount
  useEffect(() => {
    return () => closeDeployStream()
  }, [closeDeployStream])

  // Auto-scroll deployment log when streaming
  useEffect(() => {
    if (deployLogRef.current && selectedDeployment?.status === 'running') {
      deployLogRef.current.scrollTop = deployLogRef.current.scrollHeight
    }
  }, [deploymentLog, selectedDeployment?.status])

  const handleServiceAction = async (action: 'start' | 'stop' | 'restart') => {
    if (!siteId) return
    setActionBusy(action)
    setError(null)
    try {
      const res = await fetch(`/api/services/${siteId}/${action}`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Failed to ${action} service`)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action}`)
    } finally {
      setActionBusy(null)
    }
  }

  const loadWebhook = async () => {
    if (!siteId) return
    setWebhookLoading(true)
    setGhHookError(null)
    try {
      const [secretRes, ghRes] = await Promise.all([
        fetch(`/api/projects/${siteId}/webhook`),
        fetch(`/api/projects/${siteId}/webhook/github`),
      ])
      if (secretRes.ok) {
        const data = await secretRes.json()
        setWebhookHasSecret(data.hasSecret)
        setWebhookSecret(data.secret)
      }
      if (ghRes.ok) {
        const ghData = await ghRes.json()
        setGhHookInstalled(ghData.installed ?? false)
      }
    } catch {
      // ignore
    } finally {
      setWebhookLoading(false)
    }
  }

  const handleGenerateSecret = async () => {
    if (!siteId) return
    setWebhookGenerating(true)
    try {
      const res = await fetch(`/api/projects/${siteId}/webhook`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to generate secret')
      }
      const data = await res.json()
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

  const handleCopyWebhook = async (type: 'url' | 'secret') => {
    const text = type === 'url' ? 'https://deploy.smartcloudgh.com/api/webhooks/github' : webhookSecret
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
      const res = await fetch(`/api/sites/${siteId}/npm`)
      if (res.ok) {
        const data = await res.json()
        setNpmScripts(data.scripts || {})
      }
    } catch {
      // ignore
    }
  }, [siteId])

  const runNpmCommand = async (command: string) => {
    if (!siteId || npmRunning) return
    const trimmed = command.trim()
    if (!trimmed) return
    setNpmRunning(true)
    setError(null)
    setNpmOutput('')
    const controller = new AbortController()
    npmAbortRef.current = controller
    try {
      const res = await fetch(`/api/sites/${siteId}/npm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: trimmed }),
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to run command')
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        setNpmOutput((prev) => prev + chunk)
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setNpmOutput((prev) => prev + '\n[stopped] Command aborted by user\n')
      } else {
        setError(err instanceof Error ? err.message : 'Failed to run command')
      }
    } finally {
      setNpmRunning(false)
      npmAbortRef.current = null
    }
  }

  const stopNpmCommand = () => {
    npmAbortRef.current?.abort()
  }

  // Abort any running command stream on unmount
  useEffect(() => {
    return () => npmAbortRef.current?.abort()
  }, [])

  // Auto-scroll npm console output
  useEffect(() => {
    if (npmOutputRef.current) {
      npmOutputRef.current.scrollTop = npmOutputRef.current.scrollHeight
    }
  }, [npmOutput])

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

  const formatDuration = (start: string, end: string) => {
    const seconds = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000))
    if (seconds < 60) return `${seconds}s`
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  }

  const handleRollback = async (deployment: Deployment) => {
    if (!deployment.commit_sha) return
    const short = deployment.commit_sha.slice(0, 7)
    if (!window.confirm(`Roll back to commit ${short}? This redeploys that exact version and replaces what is currently live.`)) return
    setRollingBack(deployment.id)
    setError(null)
    try {
      const res = await fetch(`/api/deployments/${deployment.id}/rollback`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'Rollback failed')
      await refresh()
      if (body.deploymentId) {
        void handleSelectDeployment({
          id: body.deploymentId,
          project_id: siteId!,
          status: 'running',
          branch: null,
          commit_sha: deployment.commit_sha,
          started_at: new Date().toISOString(),
          finished_at: null,
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rollback failed')
    } finally {
      setRollingBack(null)
    }
  }

  const renderLogLines = (text: string) => {
    const lines = text.split(/\r?\n/)
    return lines.map((line, index) => {
      const lower = line.toLowerCase()

      // Timestamp pattern: 2026-02-08 or [2026-02-08] or ISO dates
      const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}[\sT][\d:.,+\-Z]+\s*[|:\-]?\s*|\[[\d\s:.,/\-TZ+]+\]\s*)/)

      // HTTP methods and status codes
      const hasHttp = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(line)
      const statusMatch = line.match(/\b([1-5]\d{2})\b/)
      const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0

      let className = 'text-[#c9cbd1]'
      if (lower.includes('error') || lower.includes('fatal') || lower.includes('exception') || lower.includes('elifecycle')) {
        className = 'text-[#f87171] font-medium'
      } else if (lower.includes('warn') || lower.includes('deprecat')) {
        className = 'text-[#fbbf24]'
      } else if (statusCode >= 500) {
        className = 'text-[#f87171]'
      } else if (statusCode >= 400) {
        className = 'text-[#fb923c]'
      } else if (hasHttp && statusCode >= 200 && statusCode < 300) {
        className = 'text-[#34d399]'
      } else if (hasHttp && statusCode >= 300 && statusCode < 400) {
        className = 'text-[#60a5fa]'
      } else if (lower.includes('ready') || lower.includes('started') || lower.includes('listening') || lower.includes('compiled')) {
        className = 'text-[#34d399]'
      } else if (lower.includes('info') || lower.includes('event')) {
        className = 'text-[#60a5fa]'
      } else if (lower.includes('debug') || lower.includes('trace') || lower.includes('verbose')) {
        className = 'text-[#71717a]'
      }

      return (
        <div key={`${index}-${line.slice(0, 12)}`} className={className}>
          {timestampMatch ? (
            <>
              <span className="text-[#6b7280]">{timestampMatch[1]}</span>
              {line.slice(timestampMatch[1].length)}
            </>
          ) : (
            line || ' '
          )}
        </div>
      )
    })
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-transparent text-slate-200">
        <div className="flex flex-col items-center gap-4">
          <RefreshCw className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Loading site details...</p>
        </div>
      </div>
    )
  }

  const hasRunningDeploy = deployments.some((d) => d.status === 'running')

  return (
    <AppShell
      title={project?.name || 'Site'}
      subtitle={project?.repo_url || 'No repo linked'}
      actions={
        <div className="flex items-center gap-2">
          {project?.environment === 'staging' && (
            <button
              onClick={handlePromote}
              disabled={promoting || (!!deployments[0]?.commit_sha && deployments[0].commit_sha === productionDeployment?.commit_sha)}
              className="flex items-center gap-2 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-500 transition-colors hover:bg-amber-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
              title={productionDeployment && deployments[0]?.commit_sha === productionDeployment.commit_sha ? 'Already deployed to production' : undefined}
            >
              <ArrowUpRight className={`h-3.5 w-3.5 ${promoting ? 'animate-bounce' : ''}`} />
              {promoting ? 'Promoting...' : 'Promote'}
            </button>
          )}
          <button
            onClick={handleDeploy}
            disabled={deploying || hasRunningDeploy}
            className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-all disabled:opacity-50 shadow-lg shadow-blue-500/20 ${hasRunningDeploy
              ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
              : 'bg-primary text-primary-foreground hover:bg-primary/90'
              }`}
          >
            {hasRunningDeploy ? (
              <>
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                Deploying...
              </>
            ) : (
              <>
                <Rocket className="h-3.5 w-3.5" />
                Deploy
              </>
            )}
          </button>
        </div>
      }
    >
      <div className="space-y-6">
        {/* Header / Metrics Row */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card className="glass-hover">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Status</CardTitle>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <div className={`h-2.5 w-2.5 rounded-full ${project?.is_active ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-red-500'}`} />
                <div className="text-2xl font-bold text-foreground">{project?.is_active ? 'Online' : 'Stopped'}</div>
              </div>
              <p className="text-xs text-muted-foreground mt-1">PM2 ID: {project?.pm2_name}</p>
            </CardContent>
          </Card>

          <Card className="glass-hover">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Git Info</CardTitle>
              <Terminal className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-foreground truncate">{project?.default_branch || 'main'}</div>
              <p className="text-xs text-muted-foreground mt-1 truncate">{project?.repo_url?.replace('https://github.com/', '') || 'No repo'}</p>
            </CardContent>
          </Card>

          <Card className="glass-hover">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Network</CardTitle>
              <Globe className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-foreground">{project?.port || 'N/A'}</div>
              <a href={project?.url || '#'} target="_blank" rel="noreferrer" className="text-xs text-blue-400 hover:underline mt-1 block truncate">
                {project?.url || 'No URL configured'}
              </a>
            </CardContent>
          </Card>

          <Card className="glass-hover">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Environment</CardTitle>
              <Database className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold capitalize ${project?.environment === 'production' ? 'text-purple-400' : 'text-amber-400'}`}>
                {project?.environment}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {project?.environment === 'staging' && project.production_id ? 'Linked to Prod' : 'Standalone'}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Deployment Error Banner */}
        {error && (
          <div className="rounded-md border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        <Tabs
          defaultValue="overview"
          className="space-y-4"
          onValueChange={(v) => {
            if (v === 'config') void loadWebhook()
            if (v === 'console') void loadNpmScripts()
          }}
        >
          <TabsList className="bg-transparent border border-white/[0.08]">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="deployments">Deployments</TabsTrigger>
            <TabsTrigger value="console">Console</TabsTrigger>
            <TabsTrigger value="config">Configuration</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-4">
            {/* Quick Actions */}
            <div className="flex gap-4">
              <Card className="flex-1 p-4 flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-foreground mb-1">Service Control</h3>
                  <p className="text-xs text-muted-foreground">Manage the underlying PM2 process.</p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => handleServiceAction('restart')} disabled={actionBusy !== null}>
                    <RotateCw className={`mr-2 h-3.5 w-3.5 ${actionBusy === 'restart' ? 'animate-spin' : ''}`} />
                    Restart
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => handleServiceAction('stop')} disabled={actionBusy !== null}>
                    <Square className="mr-2 h-3.5 w-3.5" />
                    Stop
                  </Button>
                </div>
              </Card>
              <Card className="flex-1 p-4 flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-foreground mb-1">Webhook Trigger</h3>
                  <p className="text-xs text-muted-foreground">Auto-deploy on git push events.</p>
                </div>
                <Button variant="secondary" size="sm" onClick={() => { setPanel('webhook'); loadWebhook(); }}>
                  Configure Webhook
                </Button>
              </Card>
            </div>

            {/* Live Console Preview */}
            <Card className="overflow-hidden">
              <CardHeader className="flex flex-row items-center justify-between border-b border-white/[0.06] py-3">
                <CardTitle className="text-sm font-medium">Live Console</CardTitle>
                <div className="flex gap-2">
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setLogsType(logsType === 'out' ? 'err' : 'out')}>
                    {logsType === 'out' ? <Terminal className="h-3.5 w-3.5" /> : <Activity className="h-3.5 w-3.5 text-red-400" />}
                  </Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleClearLogs}>
                    <RotateCw className={`h-3.5 w-3.5 ${clearingLogs ? 'animate-spin' : ''}`} />
                  </Button>
                </div>
              </CardHeader>
              <div className="bg-black/30 p-4 font-mono text-xs h-[400px] overflow-y-auto">
                {logs ? renderLogLines(logs) : <div className="text-muted-foreground italic p-4 text-center">No active logs. Start the service or trigger a deployment.</div>}
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="deployments" className="space-y-4">
            <Card className="">
              <CardHeader>
                <CardTitle>Deployment History</CardTitle>
                <CardDescription>All past and current deployments for this environment.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border border-white/[0.08]">
                  <div className="grid grid-cols-5 gap-4 p-3 text-xs font-medium text-muted-foreground border-b border-white/[0.08] bg-black/30">
                    <div>Status</div>
                    <div>Commit</div>
                    <div>Started</div>
                    <div>Duration</div>
                    <div className="text-right">Action</div>
                  </div>
                  <div className="divide-y divide-white/[0.06]">
                    {deployments.length === 0 ? (
                      <div className="p-8 text-center text-sm text-muted-foreground">No deployments found.</div>
                    ) : (
                      deployments.map((d) => (
                        <div key={d.id} className="grid grid-cols-5 gap-4 p-3 text-sm items-center hover:bg-white/[0.04] transition-colors cursor-pointer" onClick={() => handleSelectDeployment(d)}>
                          <div className="flex items-center gap-2">
                            <div className={`h-2 w-2 rounded-full ${d.status === 'success' ? 'bg-emerald-500' :
                              d.status === 'failed' ? 'bg-red-500' :
                                d.status === 'running' ? 'bg-blue-500 animate-pulse' : 'bg-gray-500'
                              }`} />
                            <span className="capitalize text-foreground">{d.status}</span>
                          </div>
                          <div className="font-mono text-xs text-muted-foreground">{d.commit_sha ? d.commit_sha.substring(0, 7) : '-'}</div>
                          <div className="text-muted-foreground">{new Date(d.started_at!).toLocaleString()}</div>
                          <div className="text-muted-foreground">
                            {d.finished_at && d.started_at ? formatDuration(d.started_at, d.finished_at) : 'Running...'}
                          </div>
                          <div className="flex items-center justify-end gap-2">
                            {d.status === 'success' && d.commit_sha && !hasRunningDeploy && (
                              <button
                                onClick={(e) => { e.stopPropagation(); void handleRollback(d) }}
                                disabled={rollingBack !== null}
                                className="rounded border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-400 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
                              >
                                {rollingBack === d.id ? 'Rolling back…' : 'Rollback'}
                              </button>
                            )}
                            {d.status === 'running' && (
                              <button
                                onClick={(e) => { e.stopPropagation(); void handleCancelDeployment(d.id) }}
                                disabled={cancellingDeploy === d.id}
                                className="rounded border border-red-500/20 bg-red-500/10 px-2 py-1 text-[11px] font-medium text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-50"
                              >
                                {cancellingDeploy === d.id ? 'Cancelling…' : 'Cancel'}
                              </button>
                            )}
                            <ChevronLeft className="h-4 w-4 text-muted-foreground" />
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* Selected Deployment Detail Overlay/Section could go here, or remain modal-like logic */}
                {/* Sheet for Deployment Details */}
                <Sheet open={!!selectedDeployment} onOpenChange={(open) => !open && setSelectedDeployment(null)}>
                  <SheetContent side="right" className="w-[85vw] sm:w-[50vw] sm:max-w-none bg-background/95 backdrop-blur-2xl border-l border-white/[0.08] text-foreground p-0 flex flex-col shadow-2xl">
                    <SheetHeader className="px-6 py-5 border-b border-white/[0.08] bg-black/30">
                      <div className="flex items-center justify-between pr-8">
                        <div className="flex flex-col gap-1.5">
                          <SheetTitle className="text-foreground text-lg font-bold tracking-tight">Deployment Details</SheetTitle>
                          <SheetDescription className="text-muted-foreground text-xs font-mono">ID: {selectedDeployment?.id}</SheetDescription>
                        </div>
                        <Badge
                          className="text-sm px-3 py-1"
                          variant={
                            selectedDeployment?.status === 'success'
                              ? 'default'
                              : selectedDeployment?.status === 'running'
                                ? 'secondary'
                                : 'destructive'
                          }
                        >
                          {selectedDeployment?.status}
                        </Badge>
                      </div>
                    </SheetHeader>

                    <div className="flex-1 overflow-hidden flex flex-col p-6 gap-6 bg-transparent">
                      <div className="grid grid-cols-2 gap-4 text-xs surface-card p-4 rounded-lg border border-white/[0.08]">
                        <div className="space-y-1">
                          <span className="text-muted-foreground font-medium uppercase tracking-wider text-[10px]">Commit</span>
                          <div className="font-mono text-foreground">{selectedDeployment?.commit_sha || '-'}</div>
                        </div>
                        <div className="space-y-1">
                          <span className="text-muted-foreground font-medium uppercase tracking-wider text-[10px]">Branch</span>
                          <div className="font-mono text-foreground">{selectedDeployment?.branch || 'main'}</div>
                        </div>
                        <div className="space-y-1">
                          <span className="text-muted-foreground font-medium uppercase tracking-wider text-[10px]">Started</span>
                          <div className="text-foreground">{selectedDeployment?.started_at ? new Date(selectedDeployment.started_at).toLocaleString() : '-'}</div>
                        </div>
                        <div className="space-y-1">
                          <span className="text-muted-foreground font-medium uppercase tracking-wider text-[10px]">Finished</span>
                          <div className="text-foreground">{selectedDeployment?.finished_at ? new Date(selectedDeployment?.finished_at).toLocaleString() : 'Running...'}</div>
                        </div>
                      </div>

                      <div className="flex-1 flex flex-col min-h-0 border border-white/[0.08] rounded-lg bg-black/30 shadow-inner overflow-hidden">
                        <div className="flex items-center justify-between px-4 py-2 border-b border-white/[0.08] bg-white/[0.03]">
                          <span className="text-xs font-semibold text-muted-foreground">Build Logs</span>
                          {selectedDeployment?.status === 'running' && <RefreshCw className="h-3 w-3 animate-spin text-blue-400" />}
                        </div>
                        <div className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed" ref={deployLogRef}>
                          {loadingDeploymentLog ? (
                            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                              <RefreshCw className="h-5 w-5 animate-spin opacity-50" />
                              <span>Loading logs...</span>
                            </div>
                          ) : (
                            deploymentLog ? renderLogLines(deploymentLog) : <div className="flex h-full items-center justify-center text-muted-foreground italic">No logs captured.</div>
                          )}
                        </div>
                      </div>
                    </div>
                  </SheetContent>
                </Sheet>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="console" className="space-y-4">
            <Card className="">
              <CardHeader>
                <CardTitle>NPM Console</CardTitle>
                <CardDescription>
                  Run npm commands directly in <code className="bg-white/[0.08] px-1 rounded text-xs">{project?.root_path}</code>.
                  Only npm / npx / pnpm / yarn commands are allowed.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Quick commands */}
                <div className="flex flex-wrap gap-2">
                  {['npm install', 'npm ci', 'npm run build', 'npm outdated', 'npm audit', 'npm dedupe'].map((cmd) => (
                    <Button
                      key={cmd}
                      variant="outline"
                      size="sm"
                      className="font-mono text-xs"
                      disabled={npmRunning}
                      onClick={() => { setNpmCommand(cmd); void runNpmCommand(cmd) }}
                    >
                      {cmd}
                    </Button>
                  ))}
                </div>

                {/* package.json scripts */}
                {Object.keys(npmScripts).length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">package.json scripts</p>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(npmScripts).map(([name, script]) => (
                        <Button
                          key={name}
                          variant="secondary"
                          size="sm"
                          className="font-mono text-xs"
                          disabled={npmRunning}
                          title={script}
                          onClick={() => { setNpmCommand(`npm run ${name}`); void runNpmCommand(`npm run ${name}`) }}
                        >
                          <Play className="mr-1.5 h-3 w-3" />
                          {name}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Custom command input */}
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-muted-foreground">$</span>
                    <input
                      className="flex h-9 w-full rounded-md border border-white/[0.08] bg-black/30 pl-7 pr-3 py-1 font-mono text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                      value={npmCommand}
                      onChange={(e) => setNpmCommand(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !npmRunning) void runNpmCommand(npmCommand) }}
                      placeholder="npm run build"
                      disabled={npmRunning}
                      spellCheck={false}
                    />
                  </div>
                  {npmRunning ? (
                    <Button variant="destructive" size="sm" className="h-9" onClick={stopNpmCommand}>
                      <Square className="mr-2 h-3.5 w-3.5" />
                      Stop
                    </Button>
                  ) : (
                    <Button size="sm" className="h-9" onClick={() => void runNpmCommand(npmCommand)} disabled={!npmCommand.trim()}>
                      <Play className="mr-2 h-3.5 w-3.5" />
                      Run
                    </Button>
                  )}
                </div>

                {/* Output terminal */}
                <div className="rounded-md border border-white/[0.08] bg-black/30 overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2 border-b border-white/[0.08] bg-white/[0.03]">
                    <span className="text-xs font-semibold text-muted-foreground">Output</span>
                    <div className="flex items-center gap-2">
                      {npmRunning && <RefreshCw className="h-3 w-3 animate-spin text-blue-400" />}
                      {npmOutput && !npmRunning && (
                        <button
                          onClick={() => setNpmOutput('')}
                          className="text-[11px] text-muted-foreground hover:text-white transition-colors"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  </div>
                  <div ref={npmOutputRef} className="p-4 font-mono text-xs h-[400px] overflow-y-auto whitespace-pre-wrap break-words">
                    {npmOutput
                      ? renderLogLines(npmOutput)
                      : <div className="text-muted-foreground italic p-4 text-center">Run a command to see output here.</div>}
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="config" className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              {/* Env Config */}
              <Card className="">
                <CardHeader>
                  <CardTitle className="text-base">Environment Variables</CardTitle>
                  <CardDescription>Manage your .env files.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex gap-2 border-b border-white/[0.08] pb-2">
                    {['.env', '.env.local'].map((file) => (
                      <button
                        key={file}
                        onClick={() => setEnvFile(file)}
                        className={`text-xs px-2 py-1 rounded-md transition-colors ${envFile === file ? 'bg-white/[0.08] text-white' : 'text-muted-foreground hover:text-white'}`}
                      >
                        {file}
                      </button>
                    ))}
                  </div>
                  <EnvEditor
                    className="h-64"
                    value={envContent}
                    onChange={setEnvContent}
                    placeholder={`# ${envFile}\nKEY=value`}
                  />
                  <div className="flex justify-end">
                    <Button size="sm" onClick={handleSaveEnv} disabled={savingEnv}>
                      {savingEnv ? 'Saving...' : 'Save Changes'}
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Webhook & Build Settings */}
              <div className="space-y-4">
                <Card className="">
                  <CardHeader>
                    <CardTitle className="text-base">Build Settings</CardTitle>
                    <CardDescription>Commands used for deployment.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid gap-1">
                      <label className="text-xs font-medium text-muted-foreground">Project Type</label>
                      <div className="bg-white/[0.06] p-2 rounded text-xs font-mono">
                        {projectTypeDefaults[project?.project_type || 'next'].label}
                      </div>
                    </div>
                    <div className="grid gap-1">
                      <label className="text-xs font-medium text-muted-foreground">Install Command</label>
                      <div className="bg-white/[0.06] p-2 rounded text-xs font-mono">{project?.install_cmd || 'npm install'}</div>
                    </div>
                    <div className="grid gap-1">
                      <label className="text-xs font-medium text-muted-foreground">Build Command</label>
                      <div className="bg-white/[0.06] p-2 rounded text-xs font-mono">{project?.build_cmd || 'npm run build'}</div>
                    </div>
                    <div className="grid gap-1">
                      <label className="text-xs font-medium text-muted-foreground">Start Command</label>
                      <div className="bg-white/[0.06] p-2 rounded text-xs font-mono">{project?.start_cmd || 'npm start'}</div>
                    </div>
                    {project?.pre_deploy_cmd && (
                      <div className="grid gap-1">
                        <label className="text-xs font-medium text-muted-foreground">Pre-deploy Script</label>
                        <div className="bg-white/[0.06] p-2 rounded text-xs font-mono">{project.pre_deploy_cmd}</div>
                      </div>
                    )}
                    {project?.post_deploy_cmd && (
                      <div className="grid gap-1">
                        <label className="text-xs font-medium text-muted-foreground">Post-deploy Script</label>
                        <div className="bg-white/[0.06] p-2 rounded text-xs font-mono">{project.post_deploy_cmd}</div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card className="">
                  <CardHeader>
                    <CardTitle className="text-base">Webhook Integration</CardTitle>
                    <CardDescription>
                      {project?.environment === 'staging'
                        ? `Auto-deploys on push to \`${project.default_branch || 'dev'}\` branch.`
                        : 'Auto-deploy on git push via GitHub webhook.'}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {project?.environment === 'staging' ? (
                      <div className="space-y-3">
                        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-400/80 space-y-1">
                          <p className="font-medium text-amber-400">Auto-deploy enabled</p>
                          <p>Pushing to <code className="bg-amber-500/10 px-1 rounded">{project.default_branch || 'dev'}</code> will automatically deploy this staging project.</p>
                          <p className="text-muted-foreground mt-1">Configure the webhook on the linked production project — one GitHub webhook handles both branches.</p>
                        </div>
                        {project.production_id && (
                          <a
                            href={`/sites/${project.production_id}?tab=config`}
                            className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
                          >
                            <ArrowUpRight className="h-3.5 w-3.5" />
                            Configure webhook on production project
                          </a>
                        )}
                      </div>
                    ) : !webhookHasSecret ? (
                      <div className="flex flex-col items-center justify-center p-4 gap-2 text-center">
                        <p className="text-sm text-muted-foreground">No webhook secret generated.</p>
                        <Button size="sm" onClick={handleGenerateSecret} disabled={webhookGenerating}>Generate Secret</Button>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {/* GitHub connection status */}
                        <div className={`flex items-center justify-between rounded-lg border p-3 ${ghHookInstalled ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-white/[0.08] bg-white/[0.02]'}`}>
                          <div className="flex items-center gap-2">
                            <div className={`h-2 w-2 rounded-full ${ghHookInstalled ? 'bg-emerald-500' : 'bg-zinc-600'}`} />
                            <span className="text-xs font-medium">
                              {ghHookInstalled === null ? 'Checking GitHub…' : ghHookInstalled ? 'Connected to GitHub' : 'Not connected to GitHub'}
                            </span>
                          </div>
                          {ghHookInstalled ? (
                            <button
                              onClick={handleRemoveGithubWebhook}
                              disabled={ghHookRemoving}
                              className="text-[11px] text-muted-foreground hover:text-red-400 transition-colors disabled:opacity-50"
                            >
                              {ghHookRemoving ? 'Removing…' : 'Remove'}
                            </button>
                          ) : (
                            <Button
                              size="sm"
                              className="h-7 text-xs"
                              onClick={handleInstallGithubWebhook}
                              disabled={ghHookInstalling}
                            >
                              {ghHookInstalling ? 'Connecting…' : 'Connect'}
                            </Button>
                          )}
                        </div>

                        {ghHookError && (
                          <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2">{ghHookError}</p>
                        )}

                        {ghHookInstalled && (
                          <p className="text-[11px] text-muted-foreground/70">
                            One webhook covers all branches — pushes to <code className="bg-white/[0.08] px-1 rounded">main</code> deploy production, pushes to <code className="bg-white/[0.08] px-1 rounded">dev</code> deploy staging.
                          </p>
                        )}

                        {/* Collapsible raw values for manual setup fallback */}
                        <details className="group">
                          <summary className="text-[11px] text-muted-foreground/50 cursor-pointer hover:text-muted-foreground select-none list-none flex items-center gap-1">
                            <ArrowUpRight className="h-3 w-3 rotate-90 group-open:rotate-180 transition-transform" />
                            Manual setup values
                          </summary>
                          <div className="mt-2 space-y-2">
                            <div className="grid gap-1">
                              <label className="text-xs font-medium text-muted-foreground">Payload URL</label>
                              <div className="flex gap-2">
                                <code className="flex-1 bg-white/[0.06] p-2 rounded text-xs truncate">https://deploy.smartcloudgh.com/api/webhooks/github</code>
                                <Button size="icon" variant="outline" className="h-8 w-8 shrink-0" onClick={() => handleCopyWebhook('url')}>
                                  {webhookCopied === 'url' ? <Terminal className="h-3 w-3" /> : <Square className="h-3 w-3" />}
                                </Button>
                              </div>
                            </div>
                            <div className="grid gap-1">
                              <label className="text-xs font-medium text-muted-foreground">Secret</label>
                              <div className="flex gap-2">
                                <code className="flex-1 bg-white/[0.06] p-2 rounded text-xs truncate">{webhookSecret || '••••••••••••••••'}</code>
                                <Button size="icon" variant="outline" className="h-8 w-8 shrink-0" onClick={() => handleCopyWebhook('secret')}>
                                  {webhookCopied === 'secret' ? <Terminal className="h-3 w-3" /> : <Square className="h-3 w-3" />}
                                </Button>
                              </div>
                            </div>
                          </div>
                        </details>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="settings" className="space-y-4">
            <Card className="">
              <CardHeader>
                <CardTitle>Project Settings</CardTitle>
                <CardDescription>General configuration for this site.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-6 max-w-4xl">
                  {/* General Info */}
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="grid gap-2">
                      <label className="text-sm font-medium">Project Name</label>
                      <input
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                        value={projectForm.name}
                        onChange={(e) => setProjectForm({ ...projectForm, name: e.target.value })}
                      />
                    </div>
                    <div className="grid gap-2">
                      <label className="text-sm font-medium">Repo URL</label>
                      <input
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                        value={projectForm.repoUrl}
                        onChange={(e) => setProjectForm({ ...projectForm, repoUrl: e.target.value })}
                        placeholder="https://github.com/user/repo"
                      />
                    </div>
                    <div className="grid gap-2">
                      <label className="text-sm font-medium">Project Type</label>
                      <select
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        value={projectForm.projectType}
                        onChange={(e) => {
                          const projectType = e.target.value as ProjectType
                          const defaults = projectTypeDefaults[projectType]
                          setProjectForm({
                            ...projectForm,
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
                    </div>
                    <div className="grid gap-2">
                      <label className="text-sm font-medium">Domain / URL</label>
                      <input
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                        value={projectForm.url}
                        onChange={(e) => setProjectForm({ ...projectForm, url: e.target.value })}
                        placeholder="https://example.com"
                      />
                    </div>
                    <div className="grid gap-2">
                      <label className="text-sm font-medium">Port</label>
                      <input
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                        value={projectForm.port}
                        onChange={(e) => setProjectForm({ ...projectForm, port: e.target.value })}
                        placeholder="3000"
                        type="number"
                      />
                    </div>
                  </div>

                  <div className="h-px bg-white/[0.08]" />

                  {/* Git & Paths */}
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="grid gap-2">
                      <label className="text-sm font-medium">Root Path</label>
                      <input
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                        value={projectForm.rootPath}
                        onChange={(e) => setProjectForm({ ...projectForm, rootPath: e.target.value })}
                        placeholder="c:\web\sites\mysite"
                      />
                    </div>
                    <div className="grid gap-2">
                      <label className="text-sm font-medium">Default Branch</label>
                      <input
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                        value={projectForm.defaultBranch}
                        onChange={(e) => setProjectForm({ ...projectForm, defaultBranch: e.target.value })}
                        placeholder="main"
                      />
                    </div>
                    <div className="grid gap-2">
                      <label className="text-sm font-medium">PM2 Process Name</label>
                      <input
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                        value={projectForm.pm2Name}
                        onChange={(e) => setProjectForm({ ...projectForm, pm2Name: e.target.value })}
                        placeholder="my-site"
                      />
                    </div>
                  </div>

                  <div className="h-px bg-white/[0.08]" />

                  {/* Build Commands */}
                  <div className="grid gap-4">
                    <div className="grid gap-2">
                      <label className="text-sm font-medium">Install Command</label>
                      <input
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 font-mono"
                        value={projectForm.installCmd}
                        onChange={(e) => setProjectForm({ ...projectForm, installCmd: e.target.value })}
                        placeholder="npm install"
                      />
                    </div>
                    <div className="grid gap-2">
                      <label className="text-sm font-medium">Build Command</label>
                      <input
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 font-mono"
                        value={projectForm.buildCmd}
                        onChange={(e) => setProjectForm({ ...projectForm, buildCmd: e.target.value })}
                        placeholder="npm run build"
                      />
                    </div>
                    <div className="grid gap-2">
                      <label className="text-sm font-medium">Start Command</label>
                      <input
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 font-mono"
                        value={projectForm.startCmd}
                        onChange={(e) => setProjectForm({ ...projectForm, startCmd: e.target.value })}
                        placeholder="npm start"
                      />
                    </div>
                    <div className="grid gap-2">
                      <label className="text-sm font-medium">Pre-deploy Script <span className="text-xs font-normal text-muted-foreground">(optional — runs after install, before build)</span></label>
                      <input
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
                        value={projectForm.preDeployCmd}
                        onChange={(e) => setProjectForm({ ...projectForm, preDeployCmd: e.target.value })}
                        placeholder="npx prisma migrate deploy"
                      />
                      <p className="text-xs text-muted-foreground">Ideal for database migrations or code generation. A non-zero exit code aborts the deployment.</p>
                    </div>
                    <div className="grid gap-2">
                      <label className="text-sm font-medium">Post-deploy Script <span className="text-xs font-normal text-muted-foreground">(optional — runs after the app is live)</span></label>
                      <input
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
                        value={projectForm.postDeployCmd}
                        onChange={(e) => setProjectForm({ ...projectForm, postDeployCmd: e.target.value })}
                        placeholder="npm run warmup"
                      />
                      <p className="text-xs text-muted-foreground">Runs after the health check passes — cache warmup, notifications, cleanup. Failure does not roll back the deployment.</p>
                    </div>
                  </div>

                  <div className="flex justify-end pt-4">
                    <Button onClick={handleSaveProject} disabled={savingProject} className="w-fit">
                      {savingProject ? 'Saving...' : 'Save Changes'}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-red-500/20 bg-red-500/5">
              <CardHeader>
                <CardTitle className="text-red-400">Danger Zone</CardTitle>
                <CardDescription className="text-red-400/70">Irreversible actions.</CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="destructive">Delete Project</Button>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </AppShell>
  )
}
