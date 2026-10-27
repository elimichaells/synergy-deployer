import { ChoiceCard } from '@/components/app/section';
import type { EnvironmentMode } from '@/lib/application-environments';
import { GitBranch } from 'lucide-react';
export interface ImportValues { name: string; branch: string; environmentMode: EnvironmentMode; stagingBranch: string }
export function ImportFields({ value, onChange }: { value: ImportValues; onChange: (patch: Partial<ImportValues>) => void }) {
  return <>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="field-label">Application name<input required maxLength={100} className="control-input" value={value.name} onChange={event => onChange({ name: event.target.value })} /></label>
                <label className="field-label">{value.environmentMode === 'staging' ? 'Staging branch' : 'Production branch'}<div className="relative"><GitBranch className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" /><input required className="control-input pl-9 font-mono" value={value.branch} onChange={event => onChange({ branch: event.target.value })} /></div></label>
              </div>

              <fieldset className="space-y-3">
                <legend className="mb-3 text-sm font-medium">Environments</legend>
                <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Environments">
                  <ChoiceCard selected={value.environmentMode === 'production'} onSelect={() => onChange({ environmentMode: 'production' })} title="Production only" description="Deploy this app to production." />
                  <ChoiceCard selected={value.environmentMode === 'staging'} onSelect={() => onChange({ environmentMode: 'staging' })} title="Staging only" description="Deploy a test environment without creating a production app." />
                  <ChoiceCard selected={value.environmentMode === 'production-staging'} onSelect={() => onChange({ environmentMode: 'production-staging' })} title="Production + Staging" description="Use separate application environments for testing and production." />
                </div>
                {value.environmentMode === 'production-staging' && <label className="field-label max-w-xs">Staging branch<input required className="control-input font-mono" value={value.stagingBranch} onChange={event => onChange({ stagingBranch: event.target.value })} /></label>}
              </fieldset>

  </>
}
