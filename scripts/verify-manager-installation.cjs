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

module.exports = { verifyInstallation };
if (require.main === module) {
  const path = require('node:path');
  const root = path.resolve(process.argv[2] || process.cwd());
  const version = require(path.join(root,'package.json')).version;
  verifyInstallation({baseUrl:'http://127.0.0.1:'+Number(process.argv[3] || 4000),version,email:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD})
    .then(result=>console.log(JSON.stringify(result)))
    .catch(error=>{console.error('Manager verification failed: '+error.message);process.exitCode=1});
}
