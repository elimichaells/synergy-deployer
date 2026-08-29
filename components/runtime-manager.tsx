'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Download, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface RuntimeStatus {
  id: string
  name: string
  purpose: string
  installed: boolean
  version: string | null
  canInstall: boolean
  installing: boolean
}

export function RuntimeManager({ isAdmin }: { isAdmin: boolean }) {
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/system/runtimes', { cache: 'no-store' })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Failed to inspect runtimes')
      setRuntimes(body.runtimes || [])
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to inspect runtimes')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const install = async (runtime: RuntimeStatus) => {
    setInstalling(runtime.id)
    setMessage(null)
    try {
      const response = await fetch('/api/system/runtimes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runtime: runtime.id }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || `${runtime.name} installation failed`)
      setRuntimes(body.runtimes || [])
      setMessage(`${runtime.name} installed successfully.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `${runtime.name} installation failed`)
    } finally {
      setInstalling(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Build runtimes</p>
          <p className="text-[11px] text-muted-foreground">Approved server toolchains used by deployment scripts.</p>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => void load()} disabled={loading} title="Refresh runtimes">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>
      <div className="divide-y divide-border/50 border-y border-border/60">
        {runtimes.map((runtime) => (
          <div key={runtime.id} className="flex items-center justify-between gap-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium">
                {runtime.installed ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <AlertTriangle className="h-4 w-4 text-amber-500" />}
                {runtime.name}
              </div>
              <p className="mt-0.5 truncate pl-6 text-[11px] text-muted-foreground">{runtime.version || runtime.purpose}</p>
            </div>
            {!runtime.installed && runtime.canInstall && isAdmin && (
              <Button variant="outline" size="sm" className="h-8 gap-2" onClick={() => void install(runtime)} disabled={!!installing}>
                {installing === runtime.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                Install
              </Button>
            )}
          </div>
        ))}
      </div>
      {message && <p className="text-xs text-muted-foreground">{message}</p>}
    </div>
  )
}
