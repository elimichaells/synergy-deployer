'use client'

import { lanAddress } from '@/scripts/lan-address.cjs'

export function LanAccessFields({ip,port,onChange,serverId}:{ip:string;port:string;onChange:(value:{lanIp:string;lanPort:string})=>void;serverId?:string}) {
  let preview='https://192.168.1.20:8443'
  try { preview=lanAddress(ip,port).url } catch { /* Keep a readable example while editing. */ }
  return <div className="space-y-4">
    <div className="grid gap-4 sm:grid-cols-[1fr_110px]">
      <label className="field-label">Server LAN IP<input required className="control-input font-mono" placeholder="192.168.1.20" value={ip} onChange={e=>onChange({lanIp:e.target.value,lanPort:port})}/></label>
      <label className="field-label">HTTPS port<input required className="control-input" type="number" min={443} max={65535} value={port} onChange={e=>onChange({lanIp:ip,lanPort:e.target.value})}/></label>
    </div>
    <p className="break-all text-sm font-medium">{preview}</p>
    <p className="text-xs leading-5 text-muted-foreground">Use a fixed private IP assigned to this server. Give each application an unused HTTPS port, such as 8443 or 8444, and allow that port from the institution network in its firewall. No domain purchase, DNS record or Cloudflare account is needed.</p>
    <div className="rounded-lg border border-border p-3 text-xs leading-5"><p className="font-medium">Trust HTTPS on institutional devices</p><p className="mt-1 text-muted-foreground">After the first route is running, download this server’s public root certificate. Your IT administrator can distribute it to trusted root stores through Group Policy or device management. Until it is trusted, browsers show a certificate warning. The certificate contains no private key.</p><a className="mt-2 inline-block underline" href={serverId?`/api/servers/${serverId}/ca`:'/api/system/local-ca'} download>Download public root certificate</a></div>
  </div>
}
