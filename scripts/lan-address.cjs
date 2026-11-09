'use strict';
// Shared by the browser, Manager and the standalone agent. No DNS lookup occurs.
function parseLanAddress(value) {
  if(typeof value!=='string'||!value||/[\s/%@?#\\]/.test(value))return null;
  const match=value.match(/^(\[[0-9a-f:]+\]|(?:\d{1,3}\.){3}\d{1,3})(?::(\d{1,5}))?$/i);
  if(!match)return null;
  let ip=match[1],family=4;
  if(ip.startsWith('[')){
    try{ip=new URL('https://'+ip).hostname.slice(1,-1)}catch{return null}
    if(!/^f[cd][0-9a-f]{2}:/i.test(ip))return null;family=6;
  }else{
    const octets=ip.split('.');if(octets.some(x=>String(Number(x))!==x||Number(x)>255))return null;
    const [a,b]=octets.map(Number);if(!(a===10||a===172&&b>=16&&b<=31||a===192&&b===168))return null;
  }
  const port=match[2]?Number(match[2]):443;
  if(port!==443&&(port<1024||port>65535))return null;
  const host=family===6?'['+ip+']':ip;
  return {ip,port,family,authority:host+(port===443?'':':'+port),url:'https://'+host+(port===443?'':':'+port)};
}
/** @param {unknown} ip @param {unknown} port */
function lanAddress(ip,port=8443){
  const raw=String(ip||'').trim(),host=raw.includes(':')&&!raw.startsWith('[')?'['+raw+']':raw;
  const result=parseLanAddress(host+':'+String(port));
  if(!result)throw Error('Enter a private LAN IP (10.x.x.x, 172.16–31.x.x, 192.168.x.x or IPv6 ULA) and HTTPS port 443 or 1024–65535');
  return result;
}
function lanCaddyDirectives(address,indent='\t'){
  const local=parseLanAddress(address);if(!local)return '';
  // Keep Caddy's shared listeners; mixing wildcard and bound sockets on 443/80
  // can shadow existing sites. Restrict by the actual peer, never forwarded headers.
  return `${indent}@outsideLan not remote_ip 127.0.0.0/8 ::1 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 fc00::/7\n${indent}handle @outsideLan {\n${indent}\trespond "Institution network access only" 403\n${indent}}\n`;
}
function assertLanInterface(address,interfaces){
  const local=parseLanAddress(address);if(!local)return;
  const addresses=Object.values(interfaces).flat().filter(Boolean).map(x=>{try{return lanAddress(x.address).ip}catch{return null}});
  if(!addresses.includes(local.ip))throw Error('The selected LAN IP is not assigned to this server. Use a fixed IP from its network interfaces.');
}
function lanProxyHeaders(address,indent='\t\t'){
  if(!parseLanAddress(address))return '';
  // Cookies are shared across ports. Reserve Manager's HttpOnly cookie so a LAN
  // application on the same IP cannot receive or overwrite the admin session.
  return `${indent}header_up Cookie "(^|;[[:space:]]*)manager_session=[^;]*" "$1"\n${indent}header_down Set-Cookie "^[[:space:]]*manager_session=.*$" ""\n`;
}
module.exports={parseLanAddress,lanAddress,lanCaddyDirectives,lanProxyHeaders,assertLanInterface};
