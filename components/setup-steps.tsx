'use client'

import { GitBranch, Box, Database, FileKey2, Globe2, ClipboardCheck } from 'lucide-react'
import { SETUP_STEPS, type SetupStep } from '@/lib/project-setup-policy'

const icons = [GitBranch, Box, Database, FileKey2, Globe2, ClipboardCheck]
const labels = ['Repository', 'Runtime & build', 'Database', 'Environment', 'Domain & TLS', 'Review & deploy']

export function SetupSteps({ step, onSelect, disabled = false }: { step: SetupStep; onSelect?: (step: SetupStep) => void; disabled?: boolean }) {
  const current = SETUP_STEPS.indexOf(step)
  return <>
    <label className="field-label lg:hidden">Setup step<select aria-label="Setup step" className="control-input" value={step} disabled={disabled || !onSelect} onChange={event => onSelect?.(event.target.value as SetupStep)}>{SETUP_STEPS.map((value, index) => <option key={value} value={value}>{index + 1} / 6 - {labels[index]}</option>)}</select></label>
    <nav aria-label="Application setup" className="setup-steps hidden lg:flex">
    {SETUP_STEPS.map((value, index) => {
      const Icon = icons[index]
      return <button key={value} type="button" aria-current={step === value ? 'step' : undefined} disabled={disabled || !onSelect} onClick={() => onSelect?.(value)} className={`setup-step ${step === value ? 'setup-step-active' : ''}`}>
        <span className="setup-step-icon"><Icon className="h-4 w-4" /></span>
        <span className="min-w-0 text-left"><span className="block text-[10px] text-muted-foreground">STEP {index + 1}</span><span className="block text-sm font-medium">{labels[index]}</span></span>
      </button>
    })}
    <span className="sr-only">Step {current + 1} of {SETUP_STEPS.length}</span>
    </nav>
  </>
}
