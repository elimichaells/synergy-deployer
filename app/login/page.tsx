'use client'

import { useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SynergyMark } from '@/components/synergy/brand'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Login failed')
      }
      window.location.href = '/'
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-4 text-foreground">
      <div className="syn-canvas pointer-events-none absolute inset-0" aria-hidden="true" />
      <div className="pointer-events-none absolute left-1/2 top-1/3 h-[420px] w-[620px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-r from-syn-violet/15 via-syn-cyan/10 to-syn-mint/10 blur-3xl" aria-hidden="true" />

      <div className="fade-in-up relative w-full max-w-[380px]">
        <div className="mb-8 flex flex-col items-center text-center">
          <SynergyMark className="h-12 w-12 text-foreground" />
          <h1 className="mt-5 text-[28px] font-semibold tracking-[-0.03em]">Sign in to Synergy</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">Ship, verify and serve every application on this host.</p>
        </div>

        <form className="space-y-3" onSubmit={handleSubmit}>
          <label className="sr-only" htmlFor="login-email">Email</label>
          <input id="login-email" className="control-input h-11" placeholder="Email address" autoComplete="username" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <label className="sr-only" htmlFor="login-password">Password</label>
          <input id="login-password" className="control-input h-11" placeholder="Password" autoComplete="current-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          {error && (
            <div role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          )}
          <Button type="submit" className="h-11 w-full" disabled={loading}>
            {loading ? 'Signing in…' : <>Continue<ArrowRight className="ml-1.5 h-4 w-4" /></>}
          </Button>
        </form>

        <div className="spectrum-line mt-10" aria-hidden="true" />
        <p className="mt-4 text-center text-xs text-muted-foreground">Zero-downtime releases · security-gated builds · automatic rollback</p>
      </div>
    </div>
  )
}
