'use client'

import { SERVER_TOOLS, type ServerInventory, type ServerToolPlan } from '@/lib/server-tool-catalog'
import { RuntimeInventoryRow } from '@/components/workspace/runtime-inventory'

export function initialToolPlan(inventory: ServerInventory): ServerToolPlan {
  return Object.fromEntries(SERVER_TOOLS.map(tool => {
    const candidate = inventory.tools[tool.id].find(item => item.compatible)
    return [tool.id, { mode: candidate ? 'reuse' : tool.required ? 'install' : 'skip', path: candidate?.path || '' }]
  })) as ServerToolPlan
}

export function ServerToolSelection({ inventory, plan, onChange, disabled }: {
  inventory: ServerInventory; plan: ServerToolPlan; onChange: (value: ServerToolPlan) => void; disabled: boolean
}) {
  const conflicts = inventory.ports.filter(port => [80,443,2029].includes(port))
  return <section className="space-y-4" aria-label="Detected services and tools">
    <div><h3 className="text-sm font-semibold">Services and tools on this server</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">Choose existing tools or install missing prerequisites. Database services and their data are preserved. Database credentials are configured later in the application’s Database step.</p></div>
    {(!inventory.portsKnown || !!conflicts.length) && <p role="alert" className="notice-error">{!inventory.portsKnown ? 'Listening ports could not be checked. Install the OS networking tools and inspect again.' : `Ports ${conflicts.join(', ')} are already occupied. Existing web services will be preserved. Plan their integration before connecting this agent; selecting Caddy’s executable does not take over its running configuration.`}</p>}
    {!!inventory.services.length && <div className="rounded-lg border border-border p-3"><p className="text-xs font-medium">Existing services — kept in place</p><ul className="mt-2 space-y-2 text-xs text-muted-foreground">{inventory.services.map(service => <li key={service.name}><span className="text-foreground">{service.name}</span> · {service.status}{service.executable && <p className="break-all font-mono">{service.executable}</p>}{service.config && <p className="break-all">Configuration / data: {service.config}</p>}</li>)}</ul><p className="mt-2 text-xs text-muted-foreground">A running service still needs a successful connection test; detection does not verify database credentials.</p></div>}
    <div className="divide-y divide-border border-y">{SERVER_TOOLS.map(tool => {
      const selection = plan[tool.id], candidates = inventory.tools[tool.id]
      const found = candidates.find(item => inventory.platform === 'win32' ? item.path.toLowerCase() === selection.path.toLowerCase() : item.path === selection.path)
      return <div key={tool.id} className="py-2">
        <RuntimeInventoryRow name={tool.name} installed={!!candidates.some(item => item.compatible)} description={selection.mode === 'reuse' ? found?.compatible ? `${found.version} · detected for the SSH account` : found?.error || 'Custom path — inspect again to verify' : selection.mode === 'install' ? 'Install this prerequisite; existing installations are kept' : 'Not configured for the agent'} actions={
          <label className="text-xs"><span className="sr-only">{tool.name} setup</span><select aria-label={`${tool.name} setup`} className="control-input min-w-36" disabled={disabled} value={selection.mode} onChange={event => onChange({ ...plan, [tool.id]: { mode: event.target.value as typeof selection.mode, path: selection.path || candidates.find(item => item.compatible)?.path || '' } })}><option value="reuse">Use existing</option>{tool.required ? <option value="install">Install prerequisite</option> : <option value="skip">Skip for now</option>}</select></label>
        } />
        {selection.mode === 'reuse' && <div className="space-y-2 pb-3 sm:pl-6">
          {candidates.length > 0 && <label className="block text-xs text-muted-foreground">Detected installations<select aria-label={`${tool.name} detected installation`} className="control-input mt-1" disabled={disabled} value={candidates.some(item => item.path === selection.path) ? selection.path : ''} onChange={event => { if (event.target.value) onChange({ ...plan, [tool.id]: { ...selection, path: event.target.value } }) }}><option value="">Custom path</option>{candidates.map(item => <option key={item.path} value={item.path}>{item.path} — {item.compatible ? item.version : 'Not usable'}</option>)}</select></label>}
          <label className="block text-xs text-muted-foreground">{tool.id === 'pm2' ? 'PM2 bin/pm2 script path' : 'Executable path'}<input aria-label={`${tool.name} executable path`} className="control-input mt-1 font-mono" disabled={disabled} value={selection.path} placeholder={inventory.platform === 'win32' ? tool.id === 'pm2' ? 'D:\\Tools\\node_modules\\pm2\\bin\\pm2' : `D:\\Tools\\${tool.id}\\${tool.id}.exe` : `/opt/tools/${tool.id}/bin/${tool.id}`} onChange={event => onChange({ ...plan, [tool.id]: { ...selection, path: event.target.value } })} /></label>
        </div>}
      </div>
    })}</div>
    <p className="text-xs leading-5 text-muted-foreground">Paths belong to this {inventory.platform === 'win32' ? 'Windows' : 'Linux'} server, not the Manager host. Setup rechecks them and tests access under {inventory.platform === 'win32' ? 'Local Service' : 'the manager-agent account'} before enrollment. Existing PM2 applications are kept separate from the agent’s process registry.</p>
  </section>
}
