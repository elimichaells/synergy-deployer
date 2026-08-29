'use client'

import { useState } from 'react'
import { Check, Clipboard, FileCode2, Loader2, RefreshCw, ShieldCheck, X } from 'lucide-react'

interface CaddyConfigResponse {
  config: string
  configSize: number
  configModifiedAt: string
}

export function CaddyConfigPanel({ canView, configPath }: { canView: boolean; configPath?: string }) {
  const [config, setConfig] = useState<CaddyConfigResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [validating, setValidating] = useState(false)
  const [validation, setValidation] = useState<{ valid: boolean; message: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const loadConfig = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/system/caddy?includeConfig=1', { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to load Caddyfile')
      setConfig(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Caddyfile')
    } finally {
      setLoading(false)
    }
  }

  const validateConfig = async () => {
    setValidating(true)
    setValidation(null)
    try {
      const res = await fetch('/api/system/caddy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'validate' }),
      })
      const data = await res.json().catch(() => ({}))
      setValidation({
        valid: res.ok && data.valid !== false,
        message: data.output || (res.ok ? 'Valid configuration' : data.error || 'Validation failed'),
      })
    } catch (err) {
      setValidation({ valid: false, message: err instanceof Error ? err.message : 'Validation failed' })
    } finally {
      setValidating(false)
    }
  }

  const copyConfig = async () => {
    if (!config) return
    await navigator.clipboard.writeText(config.config)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  if (!canView) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
        <ShieldCheck className="h-4 w-4" />
        Caddyfile access is restricted to administrators.
      </div>
    )
  }

  if (!config) {
    return (
      <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <FileCode2 className="h-5 w-5 shrink-0 text-cyan-300" />
          <div className="min-w-0">
            <p className="text-sm font-medium">Active Caddyfile</p>
            <p className="truncate font-mono text-[11px] text-muted-foreground">{configPath || 'Configuration path unavailable'}</p>
          </div>
        </div>
        <button onClick={() => void loadConfig()} disabled={loading} className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border bg-secondary px-3 text-xs font-medium hover:bg-muted disabled:opacity-50">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileCode2 className="h-3.5 w-3.5" />}
          View configuration
        </button>
        {error && <p className="text-xs text-red-300 sm:basis-full">{error}</p>}
      </div>
    )
  }

  return (
    <section className="overflow-hidden rounded-md border border-border bg-card" aria-label="Active Caddy configuration">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <FileCode2 className="h-4 w-4 text-cyan-300" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Active Caddyfile</p>
          <p className="truncate font-mono text-[10px] text-muted-foreground">
            {configPath} · {(config.configSize / 1024).toFixed(1)} KB · updated {new Date(config.configModifiedAt).toLocaleString()}
          </p>
        </div>
        <button onClick={() => void validateConfig()} disabled={validating} title="Validate configuration" className="inline-flex h-8 items-center gap-2 rounded-md border border-border px-2.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50">
          {validating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Validate
        </button>
        <button onClick={() => void copyConfig()} title="Copy configuration" aria-label="Copy configuration" className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-secondary hover:text-foreground">
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Clipboard className="h-3.5 w-3.5" />}
        </button>
        <button onClick={() => { setConfig(null); setValidation(null) }} title="Close configuration" aria-label="Close configuration" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

      {validation && (
        <div className={`border-b px-4 py-2 text-xs ${validation.valid ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-300' : 'border-red-500/20 bg-red-500/5 text-red-300'}`}>
          <div className="flex items-start gap-2">
            {validation.valid ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <X className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            <pre className="max-h-24 overflow-auto whitespace-pre-wrap font-mono">{validation.message}</pre>
          </div>
        </div>
      )}

      <div className="max-h-[34rem] overflow-auto bg-[#090b0e]">
        <pre className="min-w-max p-4 font-mono text-[12px] leading-5 text-slate-300"><code>{config.config}</code></pre>
      </div>
      <div className="border-t border-border px-4 py-2 text-[10px] text-muted-foreground">
        Read-only view. Changes are generated by Manager and must pass Caddy validation before reload.
      </div>
    </section>
  )
}
