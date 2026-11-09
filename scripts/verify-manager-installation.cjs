'use strict';
const { randomUUID } = require('node:crypto');

async function verifyInstallation({ baseUrl, version, email, password, timeoutMs = 60000, pollMs = 1000 }) {
  const target = new URL(baseUrl);
  if (target.protocol !== 'http:' || !['127.0.0.1','[::1]'].includes(target.hostname) || target.username || target.password) {
    throw Error('Installation verification must use the local Manager listener');
  }
  if (!email || !password || !version) throw Error('Administrator credentials and expected release version are required');
  const request = (route, options = {}) => fetch(new URL(route,target), { ...options, redirect:'error', signal:AbortSignal.timeout(5000) });
  const deadline = Date.now()+timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    const nonce = randomUUID();
    try {
      const response = await request('/api/manager-health?nonce='+nonce);
      const health = await response.json();
      if (response.ok && health.ready === true && health.version === version && health.nonce === nonce) { ready = true; break; }
    } catch { /* Startup is still in progress. Do not accept a static login page. */ }
    await new Promise(resolve=>setTimeout(resolve,pollMs));
  }
  if (!ready) throw Error('Manager did not confirm database readiness and the expected release version');
  const login = await request('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json',Origin:target.origin}, body:JSON.stringify({email,password}) });
  const cookie = (login.headers.getSetCookie?.() || [login.headers.get('set-cookie') || '']).find(value=>value.startsWith('manager_session='))?.split(';')[0];
  if (!login.ok || !cookie) throw Error('The new administrator could not sign in; inspect Manager logs and the control database');
  const identity = await request('/api/auth/me',{headers:{Cookie:cookie}});
  const account = await identity.json();
  if (!identity.ok || account.user?.role !== 'admin' || account.user?.email?.toLowerCase() !== email.toLowerCase()) throw Error('Administrator session verification failed');
  // This also exercises the remote-server migrations included in the installer.
  const servers = await request('/api/servers',{headers:{Cookie:cookie}});
  const inventory = await servers.json();
  if (!servers.ok || !Array.isArray(inventory.servers) || inventory.role !== 'admin') throw Error('Server management API or schema verification failed');
  return {ready:true,version,administratorLogin:true,serverManagement:true};
}

async function verifyProxy({origin,caFile,version,timeoutMs=60000,pollMs=1000}) {
  const target=new URL(origin),hostname=target.hostname.replace(/^\[|\]$/g,'');
  if(target.protocol!=='https:'||target.username||target.password||target.pathname!=='/'||target.search||target.hash)throw Error('Proxy verification requires an HTTPS origin');
  const https=require('node:https'),tls=require('node:tls'),fs=require('node:fs/promises'),{isIP}=require('node:net');
  const deadline=Date.now()+timeoutMs;let last='No HTTPS response';
  while(Date.now()<deadline){
    const nonce=randomUUID();
    try {
      const ca=await fs.readFile(caFile);
      const health=await new Promise((resolve,reject)=>{
        // Use the selected certificate identity while always connecting locally.
        // A newly installed institution hostname may not have a DNS record yet.
        const request=https.get({hostname:'127.0.0.1',port:Number(target.port||443),servername:isIP(hostname)?undefined:hostname,
          ca,rejectUnauthorized:true,checkServerIdentity:(_name,certificate)=>tls.checkServerIdentity(hostname,certificate),
          path:'/api/manager-health?nonce='+nonce,headers:{Host:target.host},signal:AbortSignal.timeout(Math.max(1,Math.min(5000,deadline-Date.now())))},response=>{
          let body='';response.on('data',chunk=>{body+=chunk;if(body.length>65536)request.destroy(Error('HTTPS readiness response was too large'))});
          response.on('error',reject);response.on('end',()=>{try{if(response.statusCode!==200)throw Error('HTTPS readiness HTTP '+response.statusCode);resolve(JSON.parse(body))}catch(error){reject(error)}});
        });request.on('error',reject);
      });
      if(health.ready===true&&health.version===version&&health.nonce===nonce)return {httpsVerified:true};
      last='HTTPS did not return the expected ready Manager';
    }catch(error){last=error.code||error.message;}
    if(Date.now()<deadline)await new Promise(r=>setTimeout(r,Math.min(pollMs,deadline-Date.now())));
  }
  throw Error('Manager HTTPS verification failed: '+last);
}

module.exports = { verifyInstallation, verifyProxy };
if (require.main === module) {
  const path = require('node:path');
  const root = path.resolve(process.argv[2] || process.cwd());
  const version = require(path.join(root,'package.json')).version;
  verifyInstallation({baseUrl:'http://127.0.0.1:'+Number(process.argv[3] || 4000),version,email:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD})
    .then(async result=>{if(process.argv[4])Object.assign(result,await verifyProxy({origin:process.argv[4],caFile:process.argv[5],version}));console.log(JSON.stringify(result))})
    .catch(error=>{console.error('Manager verification failed: '+error.message);process.exitCode=1});
}
