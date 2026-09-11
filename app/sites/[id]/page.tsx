'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { watchDeployment } from '@/lib/deployment-watch'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
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
  ArrowUpRight,
  KeyRound,
  Link2,
  Loader2,
  Copy,
  Check
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { AppShell } from '@/components/layout/app-shell'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { EnvEditor } from '@/components/env-editor'
import { DataMigrationWizard } from '@/components/data-migration-wizard'
import { DataRemovalAction } from '@/components/data-removal-action'
import { ProjectSetup } from '@/components/project-setup'
import { RelatedApplications } from '@/components/related-applications'
import { RuntimeManager } from '@/components/runtime-manager'
import { PROJECT_TYPES as projectTypeDefaults, getProjectCommandOverrides, type ProjectType } from '@/lib/project-types'

interface Project {
  setup_required?: boolean
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

interface GitHubConnectionOption {
  id: string
  name: string
  account_login: string
}

interface Deployment {
  log?: string | null
  is_active?: boolean
  phase?: string
  security_status?: string
  id: string
  project_id: string
  status: 'queued' | 'running' | 'success' | 'failed'
  branch: string | null
  commit_sha: string | null
  started_at: string | null
  finished_at: string | null
}

interface ManagedProjectDatabase {
  project_id: string
  project_name: string
  environment: 'production' | 'staging'
  database_name: string
  role_name: string
  created_at: string
  updated_at: string
}

interface ProjectDataService {
  id: string
  name: string
  provider: string
  connection_name: string
  database_name: string
  username: string | null
  env_prefix: string
  application_primary: boolean
  removal_blocked_reason: string | null
  options: { ownership?: 'manager' | 'external' }
}

interface DataConnectionOption {
  id: string
  name: string
  provider: 'postgresql' | 'mysql' | 'mariadb' | 'sqlserver' | 'mongodb' | 'redis'
  host: string
  port: number
  last_status: string
  is_default: boolean
  provisioning_enabled: boolean
}

interface ToolchainRuntime { id: 'node' | 'php' | 'go'; name: string; installedVersions: string[] }

const dataProviderLabels: Record<DataConnectionOption['provider'], string> = { postgresql: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', sqlserver: 'SQL Server', mongodb: 'MongoDB', redis: 'Redis' }
const inputClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring'

function dataServiceEnvLabel(service: ProjectDataService, projectType?: ProjectType) {
  if (!service.application_primary) return `${service.env_prefix}_*`
  if (projectType === 'next' || projectType === 'node') return 'DATABASE_*'
  if (service.provider === 'mongodb') return 'MONGODB_URI'
  if (service.provider === 'redis') return 'REDIS_URL'
  return 'DB_*'
}

export default function SitePage() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const siteId = Array.isArray(params.id) ? params.id[0] : params.id
  const [project, setProject] = useState<Project | null>(null)
  const [userRole, setUserRole] = useState<'admin' | 'operator' | 'viewer'>('viewer')
  const [canRemoveData, setCanRemoveData] = useState(false)
  useEffect(() => {
    let current = true
    void fetch('/api/auth/me').then((response) => response.ok ? response.json() : null).then((body) => {
      if (current) {
        setUserRole(body?.user?.role || 'viewer')
        setCanRemoveData(body?.user?.role === 'admin')
      }
    }).catch(() => { if (current) setCanRemoveData(false) })
    return () => { current = false }
  }, [])
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [productionDeployment, setProductionDeployment] = useState<Deployment | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('overview')
  const [consoleCommands, setConsoleCommands] = useState<string[]>([])
  useEffect(() => {
    const selectTab = () => {
      const value = new URLSearchParams(window.location.search).get('tab')
      setActiveTab(value && ['overview', 'deployments', 'setup', 'console', 'config', 'settings'].includes(value) ? value : 'overview')
    }
    selectTab()
    window.addEventListener('popstate', selectTab)
    return () => window.removeEventListener('popstate', selectTab)
  }, [siteId, searchParams])
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
  const deployStreamRef = useRef<{ close(): void } | null>(null)
  const [editing, setEditing] = useState(false)
  const [savingProject, setSavingProject] = useState(false)
  const [savingAutoDeploy, setSavingAutoDeploy] = useState(false)
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
    deployScript: '',
    startCmd: '',
    preDeployCmd: '',
    postDeployCmd: '',
    autoDeploy: true,
    githubConnectionId: '',
    runtimeVersions: {} as { node?: string; php?: string; go?: string },
  })
  const [githubConnections, setGithubConnections] = useState<GitHubConnectionOption[]>([])
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
  const [managedDatabase, setManagedDatabase] = useState<ManagedProjectDatabase | null>(null)
  const [dataServices, setDataServices] = useState<ProjectDataService[]>([])
  const [dataConnections, setDataConnections] = useState<DataConnectionOption[]>([])
  const [databaseBusy, setDatabaseBusy] = useState(false)
  const [syncingDataEnv, setSyncingDataEnv] = useState(false)
  const [databaseNotice, setDatabaseNotice] = useState<string | null>(null)
  const [serviceOpen, setServiceOpen] = useState(false)
  const [serviceBusy, setServiceBusy] = useState(false)
  const [serviceForm, setServiceForm] = useState({ mode: 'provision' as 'provision' | 'existing', connectionId: '', name: 'primary', databaseName: '', credentialMode: 'generated' as 'generated' | 'manual', username: '', password: '', passwordConfirmation: '', envPrefix: 'PRIMARY', applicationPrimary: false, syncEnv: false, backupEnabled: true })
  const [credentialService, setCredentialService] = useState<ProjectDataService | null>(null)
  const [credentialPassword, setCredentialPassword] = useState('')
  const [credentialConfirmation, setCredentialConfirmation] = useState('')
  const [credentialBusy, setCredentialBusy] = useState(false)
  const [toolchainRuntimes, setToolchainRuntimes] = useState<ToolchainRuntime[]>([])
  const loadToolchainRuntimes = useCallback(async () => {
    const response = await fetch('/api/system/runtimes?toolchains=true', { cache: 'no-store' })
    if (!response.ok) return
    setToolchainRuntimes(((await response.json()).runtimes || []).filter((runtime: ToolchainRuntime) => ['node', 'php', 'go'].includes(runtime.id)))
  }, [])
  const selectedDataConnection = useMemo(() => dataConnections.find((connection) => connection.id === serviceForm.connectionId), [dataConnections, serviceForm.connectionId])

  const refresh = useCallback(async () => {
    setError(null)
    try {
      const [projectRes, deploymentsRes, connectionsRes, databaseRes, dataServicesRes, runtimesRes, dataConnectionsRes] = await Promise.all([
        fetch(`/api/sites/${siteId}`),
        fetch('/api/deployments'),
        fetch('/api/github/connections'),
        fetch(`/api/sites/${siteId}/database`),
        fetch(`/api/sites/${siteId}/data-services`),
        fetch('/api/system/runtimes?toolchains=true'),
        fetch('/api/data/connections'),
      ])
      if (!projectRes.ok) throw new Error('Failed to load site')
      if (!deploymentsRes.ok) throw new Error('Failed to load deployments')

      const projectData = await projectRes.json()
      const deploymentsData = await deploymentsRes.json()
      if (connectionsRes.ok) setGithubConnections((await connectionsRes.json()).connections || [])
      if (databaseRes.ok) setManagedDatabase((await databaseRes.json()).database || null)
      if (dataServicesRes.ok) setDataServices((await dataServicesRes.json()).services || [])
      if (runtimesRes.ok) setToolchainRuntimes(((await runtimesRes.json()).runtimes || []).filter((runtime: ToolchainRuntime) => ['node', 'php', 'go'].includes(runtime.id)))
      if (dataConnectionsRes.ok) {
        const loadedConnections: DataConnectionOption[] = (await dataConnectionsRes.json()).connections || []
        setDataConnections(loadedConnections)
        setServiceForm((current) => ({ ...current, connectionId: current.connectionId || loadedConnections.find((connection) => connection.is_default && connection.provisioning_enabled && connection.last_status === 'healthy')?.id || '' }))
      }
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

  const manageProjectDatabase = async (action: 'create' | 'rotate_password') => {
    setDatabaseBusy(true)
    setDatabaseNotice(null)
    try {
      const response = await fetch(`/api/sites/${siteId}/database`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Database operation failed')
      setManagedDatabase(body.database)
      setDatabaseNotice(action === 'create'
        ? 'Isolated database created. Credentials will be injected during deployments.'
        : 'Database password rotated. Redeploy the application to refresh its runtime environment.')
    } catch (err) {
      setDatabaseNotice(err instanceof Error ? err.message : 'Database operation failed')
    } finally {
      setDatabaseBusy(false)
    }
  }

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

  const requestDataServiceEnvSync = async (options: { preview?: boolean; confirmApplicationChange?: boolean } = {}) => {
    const response = await fetch(`/api/sites/${siteId}/data-services/sync-env`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: '.env', restart: !options.preview, preview: options.preview, confirmApplicationChange: options.confirmApplicationChange }),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error || 'Database credentials could not be synced')
    if (envFile === '.env') await loadEnv('.env')
    return body
  }

  const confirmAndSyncDataServiceEnv = async () => {
    const preview = await requestDataServiceEnvSync({ preview: true })
    if (preview.runtimeBlockers?.length) throw new Error(preview.runtimeBlockers.join(' '))
    if (preview.changesApplicationDatabase) {
      const service = preview.activeService
      const confirmed = window.confirm(`Switch ${project?.name || 'this application'} to ${service?.provider || 'the selected database'} ${service?.database_name || ''}? Manager will back up .env and restart only this application.`)
      if (!confirmed) return null
    }
    return requestDataServiceEnvSync({ confirmApplicationChange: preview.changesApplicationDatabase })
  }

  const syncDataServiceEnv = async () => {
    if (!siteId) return
    setSyncingDataEnv(true)
    setDatabaseNotice(null)
    try {
      const body = await confirmAndSyncDataServiceEnv()
      if (!body) {
        setDatabaseNotice('Environment sync cancelled. No file or process was changed.')
        return
      }
      setDatabaseNotice(`${body.keys.length} database environment variables were written to .env${body.backupFile ? `; backup: ${body.backupFile}` : ''}.${body.restart?.success ? ' The application was restarted with the new environment.' : ' Application restart needs attention.'}`)
    } catch (err) {
      setDatabaseNotice(err instanceof Error ? err.message : 'Database credentials could not be synced')
    } finally {
      setSyncingDataEnv(false)
    }
  }

  const completeMigrationCutover = async () => {
    const body = await confirmAndSyncDataServiceEnv()
    if (!body) {
      setDatabaseNotice('The migration target is selected as the application database. Environment sync was cancelled and can be completed here when ready.')
      await refresh()
      return false
    }
    setDatabaseNotice(`${body.keys.length} database environment variables were written to .env.${body.restart?.success ? ' The application restarted with the migrated database.' : ' Application restart needs attention.'}`)
    await refresh()
    return true
  }

  const createProjectDataService = async () => {
    if (!siteId || !serviceForm.connectionId) return
    const manualCredentials = serviceForm.mode === 'existing' || serviceForm.credentialMode === 'manual'
    if (manualCredentials && serviceForm.password !== serviceForm.passwordConfirmation) {
      setDatabaseNotice('Database password confirmation does not match.')
      return
    }
    setServiceBusy(true)
    setDatabaseNotice(null)
    try {
      const response = await fetch(`/api/sites/${siteId}/data-services`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: serviceForm.mode,
          connectionId: serviceForm.connectionId,
          name: serviceForm.name,
          databaseName: serviceForm.databaseName,
          username: manualCredentials ? serviceForm.username : '',
          password: manualCredentials ? serviceForm.password : '',
          envPrefix: serviceForm.envPrefix,
          applicationPrimary: serviceForm.applicationPrimary,
          backupEnabled: selectedDataConnection?.provider === 'postgresql' && serviceForm.backupEnabled,
        }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Data service could not be created')
      let syncMessage = 'Credentials remain encrypted and will be injected during deployment.'
      if (serviceForm.syncEnv) {
        try {
          const sync = await confirmAndSyncDataServiceEnv()
          syncMessage = sync ? `${sync.keys.length} project-aware variables were safely synced to .env.${sync.restart?.success ? ' The application was restarted.' : ' Application restart needs attention.'}` : 'Environment sync was cancelled; the database remains attached.'
        } catch (syncError) {
          syncMessage = `The database was created, but .env sync needs attention: ${syncError instanceof Error ? syncError.message : 'sync failed'}.`
        }
      }
      setServiceOpen(false)
      setServiceForm((current) => ({ ...current, mode: 'provision', name: 'primary', databaseName: '', credentialMode: 'generated', username: '', password: '', passwordConfirmation: '', envPrefix: 'PRIMARY', applicationPrimary: false, syncEnv: false }))
      setDatabaseNotice(`${serviceForm.mode === 'existing' ? 'Existing database attached' : 'Database provisioned'}. ${syncMessage}`)
      await refresh()
    } catch (err) {
      setDatabaseNotice(err instanceof Error ? err.message : 'Data service could not be created')
    } finally {
      setServiceBusy(false)
    }
  }

  const setApplicationDataService = async (service: ProjectDataService) => {
    if (!siteId || service.application_primary) return
    const confirmed = window.confirm(`Make ${service.database_name} the application database? This selects its framework variables, but does not edit .env until you review and sync.`)
    if (!confirmed) return
    setDatabaseBusy(true)
    setDatabaseNotice(null)
    try {
      const response = await fetch(`/api/sites/${siteId}/data-services/${service.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationPrimary: true }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Application database could not be selected')
      setDatabaseNotice(`${service.database_name} is selected. Review and sync .env when you are ready to switch the application.`)
      await refresh()
    } catch (err) {
      setDatabaseNotice(err instanceof Error ? err.message : 'Application database could not be selected')
    } finally {
      setDatabaseBusy(false)
    }
  }

  const rotateDataServicePassword = async () => {
    if (!siteId || !credentialService) return
    if (credentialPassword !== credentialConfirmation) {
      setDatabaseNotice('Database password confirmation does not match.')
      return
    }
    setCredentialBusy(true)
    setDatabaseNotice(null)
    try {
      const response = await fetch(`/api/sites/${siteId}/data-services/${credentialService.id}/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: credentialPassword }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Database password could not be updated')
      let syncMessage = 'Redeploy to receive the encrypted runtime credential.'
      try {
        const sync = await requestDataServiceEnvSync()
        syncMessage = `${sync.keys.length} project-aware variables were synced to .env.${sync.restart?.success ? ' The application was restarted.' : ' Application restart needs attention.'}`
      } catch (syncError) {
        syncMessage = `.env sync needs attention: ${syncError instanceof Error ? syncError.message : 'sync failed'}.`
      }
      setCredentialService(null)
      setCredentialPassword('')
      setCredentialConfirmation('')
      setDatabaseNotice(`Database password updated and verified. ${syncMessage}`)
      await refresh()
    } catch (err) {
      setDatabaseNotice(err instanceof Error ? err.message : 'Database password could not be updated')
    } finally {
      setCredentialBusy(false)
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

  const handleToggleAutoDeploy = async () => {
    if (!siteId || !project || savingAutoDeploy) return
    const previousValue = project.auto_deploy
    const nextValue = !previousValue

    setSavingAutoDeploy(true)
    setError(null)
    setProject({ ...project, auto_deploy: nextValue })
    setProjectForm((current) => ({ ...current, autoDeploy: nextValue }))

    try {
      const res = await fetch(`/api/sites/${siteId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoDeploy: nextValue }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Failed to update auto deployment')
      }
    } catch (err) {
      setProject({ ...project, auto_deploy: previousValue })
      setProjectForm((current) => ({ ...current, autoDeploy: previousValue }))
      setError(err instanceof Error ? err.message : 'Failed to update auto deployment')
    } finally {
      setSavingAutoDeploy(false)
    }
  }

  const closeDeployStream = useCallback(() => {
    if (deployStreamRef.current) {
      deployStreamRef.current.close()
      deployStreamRef.current = null
    }
  }, [])

  const handleSelectDeployment = useCallback((deployment: Deployment) => {
    closeDeployStream()
    setSelectedDeployment(deployment)
    setDeploymentLog('')
    setLoadingDeploymentLog(true)

    deployStreamRef.current = watchDeployment<Deployment>(deployment.id, data => {
      setDeploymentLog(data.log || '')
      setLoadingDeploymentLog(false)
      setSelectedDeployment(current => current?.id === data.id ? data : current)
      setDeployments(current => current.map(item => item.id === data.id ? { ...item, ...data } : item))
    }, () => setLoadingDeploymentLog(false))
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
      const res = await fetch(`/api/sites/${siteId}/console`)
      if (res.ok) {
        const data = await res.json()
        setNpmScripts(data.scripts || {})
        setConsoleCommands(data.commands || [])
        setConsoleCwd((current) => current || data.root || '')
        setNpmOutput((current) => current || `Windows PowerShell\nTrueID Manager project session\nRuntime: ${Object.entries(data.runtimeVersions || {}).map(([name, version]) => `${name} ${version}`).join(', ') || 'host defaults'}\n`)
        try {
          const saved = JSON.parse(localStorage.getItem(`manager-console-history:${siteId}`) || '[]')
          if (Array.isArray(saved)) setConsoleHistory(saved.filter((entry): entry is string => typeof entry === 'string').slice(-100))
        } catch { /* Ignore malformed browser history. */ }
      }
    } catch {
      // ignore
    }
  }, [siteId])

  const runNpmCommand = async (command: string) => {
    if (!siteId || npmRunning) return
    const trimmed = command.trim()
    if (!trimmed) return
    if (/^(cls|clear)$/i.test(trimmed)) {
      setNpmOutput('')
      setNpmCommand('')
      setConsoleHistory((previous) => previous[previous.length - 1] === trimmed ? previous : [...previous, trimmed].slice(-100))
      setConsoleHistoryIndex(-1)
      requestAnimationFrame(() => terminalInputRef.current?.focus())
      return
    }
    const cwd = consoleCwd || project?.root_path || ''
    const prompt = `PS ${cwd}> ${trimmed}\n`
    setConsoleHistory((previous) => previous[previous.length - 1] === trimmed ? previous : [...previous, trimmed].slice(-100))
    setConsoleHistoryIndex(-1)
    setNpmCommand('')
    if (/^(history|get-history)$/i.test(trimmed)) {
      const displayedHistory = consoleHistory[consoleHistory.length - 1] === trimmed ? consoleHistory : [...consoleHistory, trimmed]
      setNpmOutput((previous) => `${previous}${previous && !previous.endsWith('\n') ? '\n' : ''}${prompt}${displayedHistory.map((entry, index) => `${String(index + 1).padStart(4)}  ${entry}`).join('\n')}\n`)
      requestAnimationFrame(() => terminalInputRef.current?.focus())
      return
    }
    if (/^(pwd|get-location)$/i.test(trimmed)) {
      setNpmOutput((previous) => `${previous}${previous && !previous.endsWith('\n') ? '\n' : ''}${prompt}\nPath\n----\n${cwd}\n`)
      requestAnimationFrame(() => terminalInputRef.current?.focus())
      return
    }
    setNpmRunning(true)
    setError(null)
    setNpmOutput((previous) => `${previous}${previous && !previous.endsWith('\n') ? '\n' : ''}${prompt}`)
    const controller = new AbortController()
    npmAbortRef.current = controller
    try {
      const res = await fetch(`/api/sites/${siteId}/console`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: trimmed, cwd }),
        signal: controller.signal,
      })
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
        setNpmOutput((prev) => (prev + chunk).slice(-500000))
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
      requestAnimationFrame(() => terminalInputRef.current?.focus())
    }
  }

  useEffect(() => { if (activeTab === 'console') void loadNpmScripts() }, [activeTab, loadNpmScripts])

  useEffect(() => {
    if (siteId && consoleHistory.length) localStorage.setItem(`manager-console-history:${siteId}`, JSON.stringify(consoleHistory))
  }, [consoleHistory, siteId])

  const stopNpmCommand = () => {
    npmAbortRef.current?.abort()
  }

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

  // Abort any running command stream on unmount
  useEffect(() => {
    return () => npmAbortRef.current?.abort()
  }, [])

  // Auto-scroll npm console output
  useEffect(() => {
    if (npmOutputRef.current) {
      npmOutputRef.current.scrollTop = npmOutputRef.current.scrollHeight
    }
  }, [npmOutput, npmRunning])

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
    const cleaned = text
      .replace(/#<\s*CLIXML[\s\S]*?(?:<\/Objs>|$)/gi, '')
      .replace(/<Objs\s+Version="[^"]+"\s+xmlns="http:\/\/schemas\.microsoft\.com\/powershell\/2004\/04">[\s\S]*?(?:<\/Objs>|$)/gi, '')
    const lines = cleaned.split(/\r?\n/)
    return lines.map((line, index) => {
      const lower = line.toLowerCase()

      // Timestamp pattern: 2026-02-08 or [2026-02-08] or ISO dates
      const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}[\sT][\d:.,+\-Z]+\s*[|:\-]?\s*|\[[\d\s:.,/\-TZ+]+\]\s*)/)

      // HTTP methods and status codes
      const hasHttp = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(line)
      const statusMatch = line.match(/\b([1-5]\d{2})\b/)
      const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0

      let className = 'text-[#c9cbd1]'
      if (line.startsWith('PS ')) {
        className = 'text-white font-medium mt-2'
      } else if (line === 'Windows PowerShell') {
        className = 'text-white font-semibold'
      } else if (line.startsWith('TrueID Manager project session')) {
        className = 'text-cyan-200'
      } else if (line.startsWith('[exit]') && line.endsWith('code 0')) {
        className = 'text-emerald-400'
      } else if (lower.includes('error') || lower.includes('fatal') || lower.includes('exception') || lower.includes('elifecycle')) {
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
  const visibleToolchains = toolchainRuntimes.filter((runtime) =>
    runtime.id === 'node'
      ? ['next', 'node', 'angular', 'laravel'].includes(projectForm.projectType)
      : runtime.id === 'php'
        ? projectForm.projectType === 'laravel'
        : runtime.id === 'go' && projectForm.projectType === 'go'
  )
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
          {project && (
            <div className="flex h-8 items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5">
              <span className={`text-xs font-medium ${project.auto_deploy ? 'text-emerald-400' : 'text-muted-foreground'}`}>
                Auto deploy
              </span>
              <Switch
                aria-label="Auto deploy"
                checked={project.auto_deploy}
                disabled={savingAutoDeploy || project.setup_required}
                onCheckedChange={() => void handleToggleAutoDeploy()}
                title={project.auto_deploy ? 'Disable auto deploy' : 'Enable auto deploy'}
              />
            </div>
          )}
          <button
            onClick={handleDeploy}
            disabled={deploying || hasRunningDeploy || project?.setup_required}
            title={project?.setup_required ? 'Finish application setup first' : 'Deploy application'}
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
      <div className="application-workspace space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <Link href="/sites" className="flex items-center gap-1 hover:text-foreground"><ChevronLeft className="h-3.5 w-3.5" />Applications</Link>
            <span className={project?.environment === 'production' ? 'text-emerald-300' : 'text-amber-300'}>{project?.environment}</span>
            <span>{project?.default_branch}</span><span>Port {project?.port}</span>
            {project?.setup_required && <Badge variant="secondary">Setup incomplete</Badge>}
          </div>
          <div className="flex flex-wrap items-center gap-4 text-xs">
            {project?.staging_id && <Link href={`/sites/${project.staging_id}`} className="text-amber-300 hover:underline">Staging workspace</Link>}
            {project?.production_id && <Link href={`/sites/${project.production_id}`} className="text-emerald-300 hover:underline">Production workspace</Link>}
            <Link href={`/automation?project=${siteId}`} className="text-muted-foreground hover:text-foreground">Jobs & workers</Link>
            {project?.url && <a href={project.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-primary">Open application<ArrowUpRight className="h-3.5 w-3.5" /></a>}
          </div>
        </div>
        {project?.setup_required && activeTab !== 'setup' && <div className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-primary bg-primary/5 p-4"><p className="text-sm">Application setup is incomplete.</p><Button size="sm" onClick={() => setActiveTab('setup')}>Continue setup</Button></div>}

        {/* Deployment Error Banner */}
        {error && (
          <div className="rounded-md border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        <Tabs
          value={activeTab}
          className="space-y-4"
          onValueChange={(v) => {
            setActiveTab(v)
            window.history.replaceState(null, '', `?tab=${v}`)
            if (v === 'config') void loadWebhook()
          }}
        >
          <TabsList className="workspace-tabs">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="deployments">Deployments</TabsTrigger>
            <TabsTrigger value="setup">Setup</TabsTrigger>
            <TabsTrigger value="console">Console</TabsTrigger>
            <TabsTrigger value="config">Environment & hooks</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="setup">
            {project && <ProjectSetup key={project.id} projectId={project.id} onChanged={() => void refresh()} onDeploy={() => { setActiveTab('deployments'); void handleDeploy() }} deploying={deploying || hasRunningDeploy} database={(
            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
                <div><CardTitle className="flex items-center gap-2"><Database className="h-4 w-4" /> Attached databases</CardTitle></div>
                <div className="flex flex-wrap justify-end gap-2">{project && project.project_type !== 'angular' && <DataMigrationWizard projectId={project.id} projectName={project.name} services={dataServices} canRemove={canRemoveData} onAddService={() => setServiceOpen(true)} onActivated={completeMigrationCutover} onChanged={refresh} />}{dataServices.length > 0 && project?.project_type !== 'angular' && <Button variant="outline" size="sm" onClick={() => void syncDataServiceEnv()} disabled={syncingDataEnv}><RefreshCw className={`mr-2 h-4 w-4 ${syncingDataEnv ? 'animate-spin' : ''}`} />Review .env sync</Button>}<Button size="sm" onClick={() => setServiceOpen(true)} disabled={!dataConnections.length || project?.project_type === 'angular'}><Plus className="mr-2 h-4 w-4" />Add service</Button></div>
              </CardHeader>
              <CardContent className="space-y-4">
                {project?.project_type === 'angular' ? (
                  <p className="text-sm text-muted-foreground">Angular is browser-side. Connect it to a backend API instead of placing database credentials in the application.</p>
                ) : dataServices.length ? (
                  <div className="divide-y divide-border border-y border-border">
                    {dataServices.map((service) => <div key={service.id} className="grid gap-3 py-3 sm:grid-cols-[1fr_1fr_auto] sm:items-center"><div className="flex min-w-0 items-center gap-2"><div className="min-w-0"><p className="truncate text-sm font-medium">{service.name}</p><p className="truncate text-xs text-muted-foreground">{service.connection_name} · {service.provider}</p>{canRemoveData && service.removal_blocked_reason && <p className="mt-1 text-xs text-muted-foreground">{service.removal_blocked_reason}</p>}</div>{service.application_primary && <Badge variant="secondary">Application DB</Badge>}</div><div><p className="font-mono text-xs">{service.database_name}</p><p className="font-mono text-[11px] text-muted-foreground">{service.username || 'Connection credential'} · {dataServiceEnvLabel(service, project?.project_type)}</p></div><div className="flex flex-wrap items-center justify-end gap-1">{!service.application_primary && <Button variant="ghost" size="sm" onClick={() => void setApplicationDataService(service)} disabled={databaseBusy}><Database className="mr-2 h-4 w-4" />Use for app</Button>}{['mysql', 'mariadb'].includes(service.provider) && <Button asChild variant="ghost" size="sm"><a href="/mysql/" target="_blank" rel="noreferrer"><ArrowUpRight className="mr-2 h-4 w-4" />phpMyAdmin</a></Button>}{service.options?.ownership !== 'external' && service.provider !== 'redis' && <Button variant="ghost" size="sm" onClick={() => { setCredentialService(service); setCredentialPassword(''); setCredentialConfirmation('') }}><KeyRound className="mr-2 h-4 w-4" />Password</Button>}<Button asChild variant="ghost" size="sm"><Link href={`/data-services?project=${project?.id || ''}`}>Advanced</Link></Button>{canRemoveData && <DataRemovalAction kind="resource" name={service.name} endpoint={`/api/sites/${siteId}/data-services/${service.id}`} blockedReason={service.removal_blocked_reason} disabled={databaseBusy} onRemoved={refresh} />}</div></div>)}
                  </div>
                ) : managedDatabase ? (
                  <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <p className="text-xs text-muted-foreground">Database</p>
                        <p className="mt-1 font-mono text-sm">{managedDatabase.database_name}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Application role</p>
                        <p className="mt-1 font-mono text-sm">{managedDatabase.role_name}</p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/database?database=${encodeURIComponent(managedDatabase.database_name)}`}>Manage data</Link>
                      </Button>
                      <Button asChild variant="outline" size="sm">
                        <a href={`/postgres/connect/${project?.id}`} target="_blank" rel="noreferrer">Open SQL client</a>
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => void manageProjectDatabase('rotate_password')} disabled={databaseBusy}>
                        {databaseBusy ? 'Working...' : 'Rotate password'}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <p className="max-w-2xl text-sm text-muted-foreground">No database attached.</p>
                    <Link className="text-xs text-primary" href="/data-services">Manage infrastructure connections</Link>
                  </div>
                )}
                {databaseNotice && <p className="text-xs text-muted-foreground">{databaseNotice}</p>}
              </CardContent>
            </Card>

            )} />}
          </TabsContent>
          <TabsContent value="overview" className="space-y-4">
            {project && <RelatedApplications key={project.id} projectId={project.id} />}
            {/* Quick Actions */}
            <div className="grid gap-6 xl:grid-cols-2">
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
                          <div className="flex flex-wrap items-center gap-2">
                            <div className={`h-2 w-2 rounded-full ${d.status === 'success' ? 'bg-emerald-500' :
                              d.status === 'failed' ? 'bg-red-500' :
                                d.status === 'running' ? 'bg-blue-500 animate-pulse' : 'bg-gray-500'
                              }`} />
                            <span className="capitalize text-foreground">{d.status}</span>
                            {d.is_active && <Badge variant="secondary">Active</Badge>}
                            {d.status === 'running' && d.phase && <span className="text-[11px] text-muted-foreground">{d.phase}</span>}
                            {d.security_status === 'failed' && <span className="text-[11px] text-red-400">Security gate</span>}
                          </div>
                          <div className="font-mono text-xs text-muted-foreground">{d.commit_sha ? d.commit_sha.substring(0, 7) : '-'}</div>
                          <div className="text-muted-foreground">{new Date(d.started_at!).toLocaleString()}</div>
                          <div className="text-muted-foreground">
                            {d.finished_at && d.started_at ? formatDuration(d.started_at, d.finished_at) : 'Running...'}
                          </div>
                          <div className="flex items-center justify-end gap-2">
                            {d.status === 'success' && !d.is_active && d.commit_sha && !hasRunningDeploy && (
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
                <Sheet open={!!selectedDeployment} onOpenChange={(open) => { if (!open) { closeDeployStream(); setSelectedDeployment(null) } }}>
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
                          <div className="font-mono text-foreground">{selectedDeployment?.branch || '—'}</div>
                        </div>
                        <div className="space-y-1">
                          <span className="text-muted-foreground font-medium uppercase tracking-wider text-[10px]">Started</span>
                          <div className="text-foreground">{selectedDeployment?.started_at ? new Date(selectedDeployment.started_at).toLocaleString() : '-'}</div>
                        </div>
                        <div className="space-y-1">
                          <span className="text-muted-foreground font-medium uppercase tracking-wider text-[10px]">Finished</span>
                          <div className="text-foreground">{selectedDeployment?.finished_at ? new Date(selectedDeployment?.finished_at).toLocaleString() : ['running', 'queued'].includes(selectedDeployment?.status || '') ? 'Running...' : '—'}</div>
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
                <CardTitle>Command console</CardTitle>
                <CardDescription>
                  Run any Windows-compatible command from <code className="break-all text-xs">{project?.root_path}</code>. Selected project runtimes and environment variables are applied automatically.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Quick commands */}
                <div className="flex flex-wrap gap-2">
                  {consoleCommands.map((cmd) => (
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

                <div className="overflow-hidden rounded-xl border border-sky-300/20 bg-black shadow-2xl shadow-black/60 ring-1 ring-white/[0.06]">
                  <div className="flex items-center justify-between border-b border-white/[0.1] bg-gradient-to-r from-[#111827] via-[#080b12] to-[#07131f] px-4 py-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex gap-1.5" aria-hidden="true">
                        <span className="h-2.5 w-2.5 rounded-full bg-rose-500 shadow-sm shadow-rose-500/50" />
                        <span className="h-2.5 w-2.5 rounded-full bg-amber-400 shadow-sm shadow-amber-400/50" />
                        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400/50" />
                      </div>
                      <span className="truncate font-mono text-xs text-blue-100">
                        <span className="font-semibold text-white">Windows PowerShell</span>
                        <span className="text-sky-300"> — </span>
                        <span className="text-cyan-200">{project?.name || 'Project'}</span>
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-slate-500">
                        <span className={`h-1.5 w-1.5 rounded-full ${npmRunning ? 'animate-pulse bg-amber-400' : 'bg-emerald-400'}`} />
                        {npmRunning ? 'running' : 'ready'}
                      </span>
                      {npmOutput && <button onClick={async () => { await navigator.clipboard.writeText(npmOutput); setConsoleCopied(true); setTimeout(() => setConsoleCopied(false), 1200) }} className="flex items-center gap-1 text-[11px] text-blue-200/60 transition-colors hover:text-white">{consoleCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}{consoleCopied ? 'Copied' : 'Copy'}</button>}
                      {npmOutput && !npmRunning && <button onClick={() => { setNpmOutput(''); requestAnimationFrame(() => terminalInputRef.current?.focus()) }} className="text-[11px] text-blue-200/60 transition-colors hover:text-white">Clear</button>}
                    </div>
                  </div>

                  <div
                    ref={npmOutputRef}
                    className="h-[500px] cursor-text overflow-y-auto whitespace-pre-wrap break-words bg-black p-5 font-mono text-xs leading-5 text-slate-100 selection:bg-sky-500/30"
                    onClick={() => terminalInputRef.current?.focus()}
                  >
                    {npmOutput && renderLogLines(npmOutput)}
                    <div className="mt-1 flex min-h-7 items-start gap-2 text-sm leading-7">
                      <span className="shrink-0 font-semibold text-white">PS</span>
                      <span className="shrink-0 text-cyan-200">{consoleCwd || project?.root_path}</span>
                      <span className="shrink-0 font-semibold text-white">&gt;</span>
                      <input
                        ref={terminalInputRef}
                        className="min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-sm leading-7 text-yellow-200 caret-white outline-none placeholder:text-blue-300/50"
                        value={npmCommand}
                        onChange={(e) => setNpmCommand(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.ctrlKey && e.key.toLowerCase() === 'c' && npmRunning) { e.preventDefault(); stopNpmCommand(); return }
                          if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); setNpmOutput(''); return }
                          if (e.ctrlKey && e.key.toLowerCase() === 'u') { e.preventDefault(); setNpmCommand(''); return }
                          if (e.key === 'Escape') { e.preventDefault(); setNpmCommand(''); setConsoleHistoryIndex(-1); return }
                          if (e.key === 'Tab' && !npmRunning) { e.preventDefault(); void completeConsoleCommand(); return }
                          if (e.key === 'ArrowUp') { e.preventDefault(); const index = Math.min(consoleHistory.length - 1, consoleHistoryIndex + 1); if (index >= 0) { setConsoleHistoryIndex(index); setNpmCommand(consoleHistory[index]) } return }
                          if (e.key === 'ArrowDown') { e.preventDefault(); const index = consoleHistoryIndex - 1; setConsoleHistoryIndex(index); setNpmCommand(index >= 0 ? consoleHistory[index] : ''); return }
                          if (e.key === 'Enter' && !npmRunning) void runNpmCommand(npmCommand)
                        }}
                        aria-label="Project terminal command"
                        aria-readonly={npmRunning}
                        placeholder={npmRunning ? 'command is running…' : ''}
                        readOnly={npmRunning}
                        autoComplete="off"
                        autoFocus
                        spellCheck={false}
                      />
                      {npmRunning && <button onClick={(e) => { e.stopPropagation(); stopNpmCommand() }} className="mt-0.5 flex shrink-0 items-center gap-1.5 rounded-md bg-rose-500/15 px-2.5 py-1 text-xs leading-5 text-rose-300 transition-colors hover:bg-rose-500/25"><Square className="h-3 w-3" /> Stop</button>}
                    </div>
                    <p className="mt-1 pl-0 font-mono text-[10px] text-blue-200/40">Tab complete · ↑↓ history · Ctrl+C stop · Ctrl+L clear · Ctrl+U erase · Esc cancel line · cls/clear · pwd · history · cd</p>
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
                    className="h-[32rem] lg:h-[38rem]"
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
                    <CardTitle className="text-base">Deployment Configuration</CardTitle>
                    <CardDescription>Script and runtime command used for this application.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid gap-1">
                      <label className="text-xs font-medium text-muted-foreground">Project Type</label>
                      <div className="bg-white/[0.06] p-2 rounded text-xs font-mono">
                        {projectTypeDefaults[project?.project_type || 'next'].label}
                      </div>
                    </div>
                    {project?.deploy_script ? (
                      <div className="grid gap-1">
                        <label className="text-xs font-medium text-muted-foreground">Deployment Script</label>
                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-white/[0.06] p-3 text-xs font-mono leading-5">{project.deploy_script}</pre>
                      </div>
                    ) : (
                      <div className="grid gap-2 rounded border border-border bg-muted/20 p-3">
                        <p className="text-xs font-medium text-muted-foreground">Deployment steps</p>
                        <code className="text-xs">{project?.install_cmd ?? projectTypeDefaults[project?.project_type || 'next'].installCmd ?? 'Automatic (lockfile)'}</code>
                        {project?.pre_deploy_cmd && <code className="text-xs">{project.pre_deploy_cmd}</code>}
                        <code className="text-xs">{project?.build_cmd ?? projectTypeDefaults[project?.project_type || 'next'].buildCmd}</code>
                        {project?.post_deploy_cmd && <code className="text-xs">{project.post_deploy_cmd}</code>}
                      </div>
                    )}
                    <div className="grid gap-1">
                      <label className="text-xs font-medium text-muted-foreground">Start Command</label>
                      <div className="bg-white/[0.06] p-2 rounded text-xs font-mono">{project?.start_cmd ?? projectTypeDefaults[project?.project_type || 'next'].startCmd ?? 'Manager static server'}</div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="">
                  <CardHeader>
                    <CardTitle className="text-base">Webhook Integration</CardTitle>
                    <CardDescription>
                      {!project?.auto_deploy
                        ? 'Auto deployment is disabled. Push events are ignored; manual deployments remain available.'
                        : project?.environment === 'staging'
                        ? `Auto-deploys on push to \`${project.default_branch || 'dev'}\` branch.`
                        : 'Auto-deploy on git push via GitHub webhook.'}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {project?.environment === 'staging' ? (
                      <div className="space-y-3">
                        <div className={`rounded-md border p-3 text-xs space-y-1 ${project.auto_deploy ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-300/80' : 'border-border bg-muted/30 text-muted-foreground'}`}>
                          <p className="font-medium">Auto-deploy {project.auto_deploy ? 'enabled' : 'paused'}</p>
                          <p>Pushes to <code className="bg-black/20 px-1 rounded">{project.default_branch || 'dev'}</code> will {project.auto_deploy ? 'automatically deploy this staging project' : 'be ignored'}.</p>
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
                      <label className="text-sm font-medium">GitHub connection</label>
                      <select
                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        value={projectForm.githubConnectionId}
                        onChange={(event) => setProjectForm({ ...projectForm, githubConnectionId: event.target.value })}
                      >
                        <option value="">Legacy default connection</option>
                        {githubConnections.map((connection) => (
                          <option key={connection.id} value={connection.id}>{connection.name} (@{connection.account_login})</option>
                        ))}
                      </select>
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
                            installCmd: defaults.installCmd ?? '',
                            buildCmd: defaults.buildCmd ?? '',
                            startCmd: defaults.startCmd ?? '',
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

                  {visibleToolchains.length > 0 && <>
                    <div className="grid gap-3">
                      <div><p className="text-sm font-medium">Project toolchain</p><p className="text-xs text-muted-foreground">Pin side-by-side runtime versions for this project without changing the host default.</p></div>
                      <div className="grid gap-3 md:grid-cols-2">
                        {visibleToolchains.map((runtime) => <label key={runtime.id} className="grid gap-2 text-sm"><span>{runtime.name}</span><select className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={projectForm.runtimeVersions[runtime.id] || ''} onChange={(e) => setProjectForm({ ...projectForm, runtimeVersions: { ...projectForm.runtimeVersions, [runtime.id]: e.target.value || undefined } })}><option value="">Host default</option>{runtime.installedVersions.map((version) => <option key={version} value={version}>{version}</option>)}</select></label>)}
                      </div>
                      <div className="rounded-md border border-border/70 p-4">
                        <RuntimeManager isAdmin={userRole === 'admin'} runtimeIds={visibleToolchains.map(runtime => runtime.id)} onChanged={loadToolchainRuntimes} />
                      </div>
                      <p className="text-xs text-muted-foreground">Install versions here, select one above, and save. Console commands, deployments, web processes, and project workers then use that pinned version.</p>
                    </div>
                    <div className="h-px bg-white/[0.08]" />
                  </>}

                  {/* Deployment automation */}
                  <div className="grid gap-4">
                    <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 p-4">
                      <div>
                        <p className="text-sm font-medium">Auto deployment</p>
                        <p className="text-xs text-muted-foreground">Deploy this environment when GitHub pushes to <code className="font-mono">{projectForm.defaultBranch || 'main'}</code>.</p>
                      </div>
                      <Switch
                        checked={projectForm.autoDeploy}
                        onCheckedChange={(checked) => setProjectForm({ ...projectForm, autoDeploy: checked })}
                        aria-label="Auto deployment"
                      />
                    </div>
                    <div className="grid gap-2">
                      <label className="text-sm font-medium">Deployment script</label>
                      <textarea
                        rows={15}
                        className="min-h-72 w-full resize-y rounded-md border border-input bg-[#090b0e] px-3 py-3 font-mono text-sm leading-6 shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        value={projectForm.deployScript}
                        onChange={(e) => setProjectForm({ ...projectForm, deployScript: e.target.value })}
                        placeholder={`git pull origin $BRANCH

composer install --no-interaction --prefer-dist --optimize-autoloader
php artisan migrate --force

php artisan optimize:clear
php artisan optimize

npm install
npm run build

echo "✅ Deployment completed successfully!"`}
                      />
                      <p className="text-xs text-muted-foreground">Commands run from the project root, one line at a time, and stop on the first failure. <code className="font-mono">$BRANCH</code> resolves to the configured default branch.</p>
                    </div>
                    <div className="grid gap-2">
                      <label className="text-sm font-medium">Runtime start command</label>
                      <textarea
                        rows={3}
                        className="min-h-20 w-full resize-y rounded-md border border-input bg-[#090b0e] px-3 py-2 font-mono text-sm leading-5 shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        value={projectForm.startCmd}
                        onChange={(e) => setProjectForm({ ...projectForm, startCmd: e.target.value })}
                        placeholder={projectTypeDefaults[projectForm.projectType].startCmd ?? 'Manager static server'}
                      />
                      <p className="text-xs text-muted-foreground">PM2 uses this command to run the application after the deployment script succeeds.</p>
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

      <Sheet open={serviceOpen} onOpenChange={setServiceOpen}>
        <SheetContent className="overflow-y-auto sm:max-w-lg">
          <SheetHeader><SheetTitle>Add data service</SheetTitle><SheetDescription>{project?.name} · credentials stay encrypted and scoped to this application</SheetDescription></SheetHeader>
          <div className="mt-6 grid gap-4">
            <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-muted/30 p-1"><Button type="button" size="sm" variant={serviceForm.mode === 'provision' ? 'secondary' : 'ghost'} onClick={() => setServiceForm({ ...serviceForm, mode: 'provision', credentialMode: 'generated', username: '', password: '', passwordConfirmation: '' })}>Provision new</Button><Button type="button" size="sm" variant={serviceForm.mode === 'existing' ? 'secondary' : 'ghost'} onClick={() => setServiceForm({ ...serviceForm, mode: 'existing', credentialMode: 'manual', databaseName: '', username: '', password: '', passwordConfirmation: '' })}>Attach existing</Button></div>
            <label className="grid gap-2 text-sm">Infrastructure connection<select className={inputClass} value={serviceForm.connectionId} onChange={(event) => setServiceForm({ ...serviceForm, connectionId: event.target.value })}><option value="">Select connection</option>{dataConnections.map((connection) => <option key={connection.id} value={connection.id} disabled={serviceForm.mode === 'provision' && (!connection.provisioning_enabled || connection.last_status !== 'healthy')}>{connection.is_default ? 'Recommended · ' : ''}{connection.name} · {dataProviderLabels[connection.provider]} · {connection.last_status}</option>)}</select></label>
            <div className="grid grid-cols-2 gap-3"><label className="grid gap-2 text-sm">Service name<input className={inputClass} value={serviceForm.name} onChange={(event) => { const name=event.target.value; setServiceForm({ ...serviceForm, name, envPrefix: name.toUpperCase().replace(/[^A-Z0-9]+/g, '_') }) }} /></label><label className="grid gap-2 text-sm">Environment prefix<input className={inputClass} value={serviceForm.envPrefix} onChange={(event) => setServiceForm({ ...serviceForm, envPrefix: event.target.value.toUpperCase().replace(/[^A-Z0-9_]+/g, '') })} /></label></div>
            <label className="grid gap-2 text-sm">Database name<input className={inputClass} value={serviceForm.databaseName} onChange={(event) => setServiceForm({ ...serviceForm, databaseName: event.target.value })} placeholder={serviceForm.mode === 'existing' ? 'Existing database name' : 'Generated when blank'} /></label>
            {serviceForm.mode === 'provision' && selectedDataConnection?.provider !== 'redis' && <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-muted/30 p-1"><Button type="button" size="sm" variant={serviceForm.credentialMode === 'generated' ? 'secondary' : 'ghost'} onClick={() => setServiceForm({ ...serviceForm, credentialMode: 'generated', username: '', password: '', passwordConfirmation: '' })}>Generate credentials</Button><Button type="button" size="sm" variant={serviceForm.credentialMode === 'manual' ? 'secondary' : 'ghost'} onClick={() => setServiceForm({ ...serviceForm, credentialMode: 'manual' })}>Set manually</Button></div>}
            {(serviceForm.mode === 'existing' || serviceForm.credentialMode === 'manual') && <><label className="grid gap-2 text-sm">Database username<input className={inputClass} autoComplete="off" value={serviceForm.username} onChange={(event) => setServiceForm({ ...serviceForm, username: event.target.value })} placeholder={serviceForm.mode === 'provision' ? 'Generated from database name when blank' : ''} /></label><label className="grid gap-2 text-sm">Database password<input className={inputClass} type="password" autoComplete="new-password" value={serviceForm.password} onChange={(event) => setServiceForm({ ...serviceForm, password: event.target.value })} /></label><label className="grid gap-2 text-sm">Confirm password<input className={inputClass} type="password" autoComplete="new-password" value={serviceForm.passwordConfirmation} onChange={(event) => setServiceForm({ ...serviceForm, passwordConfirmation: event.target.value })} /></label>{serviceForm.mode === 'provision' && <p className="text-xs text-muted-foreground">Custom passwords require 16 to 256 characters.</p>}</>}
            <label className="flex items-center justify-between border-t border-border pt-3 text-sm"><span>Use as application database</span><Switch checked={serviceForm.applicationPrimary} onCheckedChange={(applicationPrimary) => setServiceForm({ ...serviceForm, applicationPrimary })} /></label>
            <label className="flex items-center justify-between border-y border-border py-3 text-sm"><span>Sync variables after adding</span><Switch checked={serviceForm.syncEnv} onCheckedChange={(syncEnv) => setServiceForm({ ...serviceForm, syncEnv })} /></label>
            {selectedDataConnection?.provider === 'postgresql' && serviceForm.mode === 'provision' && <label className="flex items-center justify-between border-b border-border pb-3 text-sm"><span>Daily automatic backup</span><Switch checked={serviceForm.backupEnabled} onCheckedChange={(backupEnabled) => setServiceForm({ ...serviceForm, backupEnabled })} /></label>}
            <Button onClick={() => void createProjectDataService()} disabled={serviceBusy || !serviceForm.connectionId || !serviceForm.name || !serviceForm.envPrefix || (serviceForm.mode === 'existing' && (!serviceForm.databaseName || !serviceForm.username || !serviceForm.password)) || (serviceForm.mode === 'provision' && serviceForm.credentialMode === 'manual' && (serviceForm.password.length < 16 || serviceForm.password !== serviceForm.passwordConfirmation))}>{serviceBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : serviceForm.mode === 'existing' ? <Link2 className="mr-2 h-4 w-4" /> : <Database className="mr-2 h-4 w-4" />}{serviceForm.mode === 'existing' ? 'Verify and attach' : 'Provision database'}</Button>
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={credentialService !== null} onOpenChange={(open) => { if (!open) { setCredentialService(null); setCredentialPassword(''); setCredentialConfirmation('') } }}>
        <SheetContent className="overflow-y-auto sm:max-w-md">
          <SheetHeader><SheetTitle>Database password</SheetTitle><SheetDescription>{credentialService ? `${credentialService.database_name} · ${credentialService.username}` : ''}</SheetDescription></SheetHeader>
          <div className="mt-6 grid gap-4"><label className="grid gap-2 text-sm">New password<input className={inputClass} type="password" autoComplete="new-password" value={credentialPassword} onChange={(event) => setCredentialPassword(event.target.value)} /></label><label className="grid gap-2 text-sm">Confirm password<input className={inputClass} type="password" autoComplete="new-password" value={credentialConfirmation} onChange={(event) => setCredentialConfirmation(event.target.value)} /></label><p className="text-xs text-muted-foreground">The password is verified against the database, encrypted in Manager, and synced to the project’s managed .env block.</p><Button onClick={() => void rotateDataServicePassword()} disabled={credentialBusy || credentialPassword.length < 16 || credentialPassword !== credentialConfirmation}>{credentialBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}Update password</Button></div>
        </SheetContent>
      </Sheet>
    </AppShell>
  )
}
