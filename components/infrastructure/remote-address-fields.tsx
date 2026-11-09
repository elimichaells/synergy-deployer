'use client'
import { useState } from 'react'
import { LanAccessFields } from '@/components/app/lan-access-fields'
import { lanAddress, parseLanAddress } from '@/scripts/lan-address.cjs'

type Address={access_mode:'lan'|'wan';hostname:string;ip_address:string;ip_port:string}
export function RemoteAddressFields({value,onChange,serverId}:{value:Address;onChange:(value:Partial<Address>)=>void;serverId:string}){
  const parsed=parseLanAddress(value.hostname)
  const [kind,setKind]=useState(value.access_mode==='wan'?'wan':parsed||!value.hostname||value.hostname.endsWith('.invalid')?'ip':'hostname')
  const [ip,setIp]=useState(parsed?.ip||'')
  const [port,setPort]=useState(String(parsed?.port||8443))
  function changeIp(nextIp:string,nextPort:string){
    setIp(nextIp);setPort(nextPort)
    let hostname=nextIp+':'+nextPort
    try{hostname=lanAddress(nextIp,nextPort).authority}catch{/* Server validation rejects unfinished input. */}
    onChange({access_mode:'lan',hostname,ip_address:'',ip_port:nextPort})
  }
  return <div className="space-y-4">
    <label className="field-label">Address type<select className="control-input" value={kind} onChange={e=>{const next=e.target.value;setKind(next);if(next==='ip')changeIp(ip,port);else onChange({access_mode:next==='wan'?'wan':'lan',hostname:parseLanAddress(value.hostname)?'':value.hostname})}}><option value="ip">Institution LAN / private IP</option><option value="hostname">Institution LAN / internal DNS</option><option value="wan">Public domain</option></select></label>
    {kind==='ip'?<LanAccessFields ip={ip} port={port} serverId={serverId} onChange={next=>changeIp(next.lanIp,next.lanPort)}/>:<>
      <label className="field-label">Hostname<input required className="control-input" placeholder={kind==='wan'?'app.example.com':'library.campus.internal'} value={value.hostname} onChange={e=>onChange({hostname:e.target.value})}/></label>
      <p className="text-xs leading-5 text-muted-foreground">{kind==='hostname'?'Point the institution’s internal DNS at this server and distribute its public root certificate to client devices. No public domain purchase is needed.':'Point DNS at this server or its gateway. Public HTTPS requires internet access and inbound ports 80/443.'}</p>
      {kind==='hostname'&&<a className="inline-block text-xs underline" href={`/api/servers/${serverId}/ca`} download>Download public root certificate</a>}
      <details className="text-xs"><summary className="cursor-pointer">Additional IP access</summary><div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="field-label">Optional IP address<input className="control-input" value={value.ip_address} onChange={e=>onChange({ip_address:e.target.value})}/></label>{value.ip_address&&<label className="field-label">IP HTTPS port<input required className="control-input" type="number" min={1024} max={65535} value={value.ip_port} onChange={e=>onChange({ip_port:e.target.value})}/></label>}</div><p className="mt-2 text-muted-foreground">Additional IP access uses the local CA. Keep application backend ports private and scope firewall access to the intended networks.</p></details>
    </>}
  </div>
}
