'use client'

export function DeploymentHooks({before,after,onChange,disabled=false}:{before:string;after:string;onChange:(values:{before?:string;after?:string})=>void;disabled?:boolean}){
  return <div className="grid gap-4 sm:grid-cols-2">
    <label className="field-label">Pre-deploy command<input className="control-input font-mono" value={before} disabled={disabled} onChange={event=>onChange({before:event.target.value})}/><span className="text-xs text-muted-foreground">Runs after installation and before the build.</span></label>
    <label className="field-label">Post-deploy command<input className="control-input font-mono" value={after} disabled={disabled} onChange={event=>onChange({after:event.target.value})}/><span className="text-xs text-muted-foreground">Runs after activation. A failure leaves the release running.</span></label>
    <p className="text-xs text-muted-foreground sm:col-span-2">A custom deployment script replaces the install, pre-deploy, build and post-deploy commands.</p>
  </div>
}
