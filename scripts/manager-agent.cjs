#!/usr/bin/env node
'use strict';

// Dependency-free Windows/Linux agent. Downloaded intact by the Manager UI.
// Only run trusted application repositories: build scripts execute as the agent account.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomBytes, X509Certificate } = require('node:crypto');
const { rootCertificates } = require('node:tls');
const { createInterface } = require('node:readline/promises');
const PROTOCOL_VERSION = 1;
const AGENT_VERSION = '1.2.0';
const SETUP_CAPABILITY = 'guided-setup-v1';
const UPDATE_CAPABILITY = 'agent-update-v1';
const ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function requireText(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) throw new Error(`Invalid ${label}`);
  return value.trim();
}
function port(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1024 || n > 65535 || [2019, 2029].includes(n)) throw new Error(`${label} must be 1024–65535 (excluding Caddy admin ports)`);
  return n;
}
function validateApp(input) {
  if (!input || typeof input !== 'object') throw new Error('Application configuration is required');
  const name = requireText(input.name, 'application name', 100);
  const repo_url = requireText(input.repo_url, 'repository URL', 1000).replace(/\/$/, '');
  if (!/^https:\/\/[\w.[\]:-]+(?:\/[\w.-]+){2,}$/i.test(repo_url) || repo_url.split('/').some(x => x === '.' || x === '..')) throw new Error('Use an HTTPS repository URL without credentials or query parameters');
  const repo = new URL(repo_url);
  if (repo.username || repo.password || repo.protocol !== 'https:') throw new Error('Invalid repository URL');
  const branch = requireText(input.branch || 'main', 'branch');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.') || branch.endsWith('.lock')) throw new Error('Invalid Git branch');
  const commands = {};
  for (const field of ['install_cmd', 'build_cmd', 'start_cmd']) {
    const value = input[field] ?? '';
    if (typeof value !== 'string' || value.length > 4000 || value.includes('\0')) throw new Error('Invalid application command');
    commands[field] = value.trim();
  }
  if (!commands.start_cmd) throw new Error('Start command is required');
  const appPort = port(input.port, 'Application port');
  const health_path = input.health_path || '/';
  if (typeof health_path !== 'string' || !/^\/(?!\/)[^\s\\#]*$/.test(health_path) || health_path.length > 500) throw new Error('Health path must start with /');
  if (!['lan','wan'].includes(input.access_mode)) throw new Error('Choose LAN or WAN access');
  const hostname = requireText(input.hostname, 'hostname', 253).toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) throw new Error('Use a complete hostname, such as library.campus.example.edu');
  if (input.access_mode === 'wan' && /\.(local|localhost|internal|test|invalid|example|lan|home|arpa)$/.test(hostname)) throw new Error('WAN mode requires a public DNS domain');
  const ip_address = typeof input.ip_address === 'string' ? input.ip_address.trim() : '';
  let ip_port = null;
  if (ip_address) {
    if (!net.isIP(ip_address) || ip_address.includes('%')) throw new Error('Invalid IP access address');
    ip_port = port(input.ip_port, 'IP HTTPS port');
    if (ip_port === appPort) throw new Error('IP HTTPS port must differ from the application port');
  }
  const environment = input.environment ?? {};
  if (typeof environment !== 'object' || !environment || Array.isArray(environment) || Object.keys(environment).length > 200) throw new Error('Environment must be an object with at most 200 variables');
  const cleanEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /^(MANAGER_AGENT_|PM2_|GIT_|NODE_EXTRA_CA_CERTS$)/i.test(key) || ['PORT','HOST','HOSTNAME','PATH','NODE_ENV','NODE_OPTIONS'].includes(key.toUpperCase())) throw new Error(`Environment variable ${key} is reserved or invalid`);
    if (typeof value !== 'string' || value.length > 16000 || value.includes('\0')) throw new Error(`Invalid value for ${key}`);
    cleanEnv[key] = value;
  }
  if (JSON.stringify(cleanEnv).length > 65536) throw new Error('Environment exceeds 64 KB');
  return { name, repo_url, branch, ...commands, port: appPort, health_path, access_mode: input.access_mode, hostname, ip_address, ip_port, environment: cleanEnv };
}

function sanitizeMetrics(raw) {
  if (!raw || !['win32','linux'].includes(raw.platform)) throw new Error('Invalid sample');
  const number = (value, max = Number.MAX_SAFE_INTEGER) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw new Error('Invalid metric');
    return value;
  };
  const optional = value => value == null ? null : number(value);
  const str = (value, max = 200) => typeof value === 'string' ? value.replace(/[\x00-\x1f]/g, '').slice(0, max) : '';
  const result = { hostname: str(raw.hostname), platform: raw.platform, version: str(raw.version, 30),
    cpuPercent: number(raw.cpuPercent, 100), memoryTotal: number(raw.memoryTotal), memoryFree: number(raw.memoryFree),
    diskTotal: optional(raw.diskTotal), diskFree: optional(raw.diskFree), uptime: number(raw.uptime),
    addresses: (Array.isArray(raw.addresses) ? raw.addresses : []).filter(x => typeof x === 'string' && net.isIP(x)).slice(0, 30),
    tools: Object.fromEntries(['node','git','pm2','caddy'].map(key => [key, str(raw.tools?.[key]) || null])),
    apps: (Array.isArray(raw.apps) ? raw.apps : []).slice(0, 200).filter(x => ID.test(x.id)).map(x => ({ id: x.id,
      status: ['online','stopped','errored','launching','stopping','missing'].includes(x.status) ? x.status : 'unknown', cpu: number(x.cpu, 10000), memory: number(x.memory) })),
    proxyError: raw.proxyError ? str(raw.proxyError, 500) : null,
    capabilities: [SETUP_CAPABILITY,UPDATE_CAPABILITY].filter(value => Array.isArray(raw.capabilities) && raw.capabilities.includes(value)) };
  if (result.memoryFree > result.memoryTotal || (result.diskFree !== null && result.diskTotal !== null && result.diskFree > result.diskTotal)) throw new Error('Invalid capacity');
  return result;
}

function redact(value, secrets) {
  let output = String(value);
  for (const secret of [...new Set(secrets.filter(x => typeof x === 'string' && x))].sort((a,b) => b.length-a.length)) output = output.split(secret).join('[redacted]');
  return output;
}
function streamRedactor(secrets, write) {
  const values = [...new Set(secrets.filter(Boolean))].sort((a,b) => b.length-a.length);
  let pending = '';
  return { write(chunk) {
    if (!values.length) { write(chunk); return; }
    pending += chunk;
    let safe = '';
    while (pending) {
      const match = values.find(value => pending.startsWith(value));
      if (match) { safe += '[redacted]'; pending = pending.slice(match.length); }
      else if (values.some(value => value.startsWith(pending))) break;
      else { safe += pending[0]; pending = pending.slice(1); }
    }
    if (safe) write(safe);
  }, end() { if (pending) write('[redacted]'); pending = ''; } };
}

function caddyConfig(apps, storageRoot) {
  const quotePath = JSON.stringify(storageRoot.replace(/\\/g, '/'));
  const sites = apps.map(raw => {
    const app = validateApp(raw);
    const block = (address, internal) => `${address} {\n${internal ? '\ttls internal\n' : ''}\treverse_proxy 127.0.0.1:${app.port}\n}\n`;
    const ip = net.isIP(app.ip_address) === 6 ? `[${app.ip_address}]` : app.ip_address;
    return block(`https://${app.hostname}`, app.access_mode === 'lan') + (ip ? block(`https://${ip}:${app.ip_port}`, true) : '');
  });
  return `{\n\tadmin 127.0.0.1:2029\n\tskip_install_trust\n\tstorage file_system {\n\t\troot ${quotePath}\n\t}\n}\n\n${sites.join('\n')}`;
}

function managerAddress(value) {
  const url = new URL(value);
  const loopback = ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Manager address must be an HTTPS origin (HTTP only for loopback tests)');
  return url.origin;
}

async function atomicJson(filename, value) {
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
  await fs.rename(temp, filename);
}
async function readJson(filename, fallback = null) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function contained(root, ...segments) {
  const target = path.resolve(root, ...segments);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path escaped the agent directory');
  let cursor = root;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('Agent paths cannot contain symlinks or junctions'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}
function baseEnv() {
  const allowed = ['PATH','Path','SystemRoot','WINDIR','ComSpec','TEMP','TMP','TMPDIR','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','PROGRAMDATA','LANG','LC_ALL'];
  return Object.fromEntries(allowed.filter(key => process.env[key]).map(key => [key,process.env[key]]));
}

function run(file, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    let output = '', settled = false, timedOut = false;
    const child = spawn(file, args, { cwd: options.cwd, env: options.env || baseEnv(), shell: !!options.shell,
      detached: process.platform !== 'win32', windowsHide: true, stdio: [options.input === undefined ? 'ignore' : 'pipe','pipe','pipe'] });
    if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(options.input); }
    const emit = text => { output = (output + text).slice(-262144); options.log?.(text); };
    const stdout = streamRedactor(options.secrets || [], emit), stderr = streamRedactor(options.secrets || [], emit);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout.write(chunk)); child.stderr.on('data', chunk => stderr.write(chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        if (process.platform === 'win32') spawn('taskkill.exe', ['/PID',String(child.pid),'/T','/F'], { windowsHide: true, stdio: 'ignore' });
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      }
    }, options.timeout || 120000);
    const finish = (error, code) => {
      if (settled) return; settled = true; clearTimeout(timer); stdout.end(); stderr.end();
      if (error || code !== 0 || timedOut) reject(new Error(timedOut ? 'Command exceeded its time limit' : error ? error.message : `Command exited ${code}: ${output.slice(-1500)}`));
      else resolve(output.trim());
    };
    child.on('error', error => finish(error)); child.on('close', code => finish(null, code));
  });
}

async function request(config, action, body) {
  const response = await fetch(`${managerAddress(config.manager)}/api/server-agent/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.agentToken}` },
    body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(result.error || `Manager returned HTTP ${response.status}`); error.status = response.status; throw error; }
  return result;
}

async function findTools(root) {
  let pm2;
  const localPm2 = path.join(root,'tools','node_modules','pm2','bin','pm2');
  try { await fs.access(localPm2); pm2 = localPm2; } catch {
    const npmRoot = process.platform === 'win32' ? await run(process.env.ComSpec || 'cmd.exe', ['/d','/s','/c','npm root -g']) : await run('npm',['root','-g']);
    pm2 = path.join(npmRoot.trim(),'pm2','bin','pm2');
  }
  await fs.access(pm2);
  const pmEnv = { ...baseEnv(), PM2_HOME: path.join(root,'pm2') };
  const pm = (args, options = {}) => run(process.execPath, [pm2, ...args], { ...options, env: pmEnv });
  const tools = { node: process.version, git: null, pm2: null, caddy: null };
  tools.git = await run('git',['--version']).catch(() => null);
  tools.pm2 = (await pm(['--version'])).split('\n').pop();
  const caddy = process.env.MANAGER_AGENT_CADDY || (process.platform === 'win32' ? 'caddy.exe' : 'caddy');
  tools.caddy = await run(caddy,['version']).catch(() => null);
  return { pm, caddy, tools };
}

async function processList(pm) {
  // PM2 can print a daemon startup banner before JSON.
  const output = await pm(['jlist']);
  const start = output.indexOf('[{');
  if (start >= 0) return JSON.parse(output.slice(start));
  if (output.trim().endsWith('[]')) return [];
  throw new Error('PM2 returned invalid process data');
}

async function checkPort(portNumber) {
  await new Promise((resolve,reject) => {
    const server = net.createServer(); server.once('error', () => reject(new Error(`Application port ${portNumber} is already in use`)));
    server.listen(portNumber, '127.0.0.1', () => server.close(resolve));
  });
}
async function healthy(app, timeout = 60000) {
  const until = Date.now()+timeout;
  let reason = 'No response';
  while (Date.now()<until) {
    try {
      const response = await fetch(`http://127.0.0.1:${app.port}${app.health_path}`, { redirect:'manual',signal:AbortSignal.timeout(3000) });
      await response.body?.cancel();
      if (response.status >= 200 && response.status < 300) return;
      reason = `HTTP ${response.status}`;
    } catch (error) { reason = error.message; }
    await wait(1000);
  }
  throw new Error(`Health check failed: ${reason}. Configure a path that returns HTTP 2xx.`);
}

async function proxyConfig(root, text, tools) {
  if (!tools.tools.caddy) throw new Error('Install Caddy and put it on the agent account PATH');
  const filename = path.join(root,'Caddyfile');
  const candidate = path.join(root,'Caddyfile.candidate');
  await fs.writeFile(candidate,text,{mode:0o600});
  await run(tools.caddy,['validate','--config',candidate,'--adapter','caddyfile']);
  const previous = await fs.readFile(filename,'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  let active = null;
  try {
    const response = await fetch('http://127.0.0.1:2029/config/',{signal:AbortSignal.timeout(3000)});
    if (!response.ok) throw new Error('Caddy admin interface refused access');
    active = await response.json();
  } catch (error) { if (error.cause?.code !== 'ECONNREFUSED') throw error; }
  if (active && path.resolve(active.storage?.root || '') !== path.join(root,'caddy-storage')) throw new Error('Caddy admin port 2029 belongs to another installation');
  await fs.rename(candidate,filename);
  try {
    if (active) await run(tools.caddy,['reload','--config',filename,'--adapter','caddyfile','--address','127.0.0.1:2029']);
    else {
      const list = await processList(tools.pm);
      if (list.some(p=>p.name==='manager-remote-caddy')) await tools.pm(['delete','manager-remote-caddy']);
      // Resolve the executable before PM2 starts it (PM2 requires a real script path).
      const found = path.isAbsolute(tools.caddy) ? tools.caddy : (await run(process.platform==='win32' ? 'where.exe':'which',[tools.caddy])).split(/\r?\n/)[0];
      await tools.pm(['start',found,'--name','manager-remote-caddy','--interpreter','none','--','run','--config',filename,'--adapter','caddyfile']);
      let ready = false;
      for (let i=0;i<20;i++) {
        await wait(500);
        const response = await fetch('http://127.0.0.1:2029/config/',{signal:AbortSignal.timeout(1000)}).catch(()=>null);
        if (response?.ok) { const config=await response.json(); if(path.resolve(config.storage?.root || '')===path.join(root,'caddy-storage')){ready=true;break;} }
      }
      if (!ready) { await tools.pm(['delete','manager-remote-caddy']).catch(()=>{}); throw new Error('Caddy could not start. Check ports 80, 443 and 2029 and the service account permissions.'); }
    }
    await tools.pm(['save','--force']);
  } catch (error) {
    if (previous !== null) {
      await fs.writeFile(filename,previous,{mode:0o600});
      if (active) await run(tools.caddy,['reload','--config',filename,'--adapter','caddyfile','--address','127.0.0.1:2029']).catch(()=>{});
    }
    throw error;
  }
}

async function writeEnv(release, environment) {
  const content = Object.entries(environment).map(([key,value])=>`${key}=${JSON.stringify(value)}`).join('\n')+'\n';
  for (const name of ['.env','.env.local']) {
    const filename = path.join(release,name);
    const stat = await fs.lstat(filename).catch(error => { if(error.code!=='ENOENT')throw error;return null; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('Environment file must be a regular file');
    await fs.writeFile(filename,content,{mode:0o600});
  }
}

async function restoreActivation(root, journal, tools, log, dependencies = {}) {
  const activation = journal.activation;
  if (!activation) return;
  log('[rollback] Restoring the previous application and routes\n');
  const name = `manager-remote-${journal.appId}`;
  const list = await processList(tools.pm);
  if (list.some(p=>p.name===name)) await tools.pm(['delete',name]);
  if (activation.previous) {
    await tools.pm(['start',activation.previous.ecosystem]);
    await (dependencies.healthy || healthy)(activation.previous.app);
  }
  await (dependencies.proxyConfig || proxyConfig)(root,caddyConfig(Object.values(activation.previousApps).map(x=>x.app),path.join(root,'caddy-storage')),tools);
  await atomicJson(path.join(root,'apps.json'),activation.previousApps);
  await tools.pm(['save','--force']);
  log(activation.previous ? '[rollback] Previous release is healthy\n' : '[rollback] Failed first release stopped\n');
}

async function deploy(root, job, journal, tools, persist, log, dependencies = {}) {
  // Dependency injection is used by integration tests to avoid production services.
  const command = dependencies.run || run;
  const checkHealth = dependencies.healthy || healthy;
  const configureProxy = dependencies.proxyConfig || proxyConfig;
  const availablePort = dependencies.checkPort || checkPort;
  if (!ID.test(job.id) || !ID.test(job.payload.id)) throw new Error('Invalid deployment identifier');
  const app = { ...validateApp(job.payload), id:job.payload.id };
  if (!tools.tools.git || !tools.tools.caddy) throw new Error('Git and Caddy must be installed before deploying');
  const applications = await readJson(path.join(root,'apps.json'),{});
  const previous = applications[app.id] || null;
  const release = await contained(root,'releases',app.id,job.id);
  await fs.mkdir(path.dirname(release),{recursive:true,mode:0o700});
  if (await fs.lstat(release).catch(()=>null)) throw new Error('Release directory already exists; refusing to replay this deployment');
  log('[stage] checkout\n');
  const gitConfig = [['credential.helper',''],['http.extraHeader',''],['http.followRedirects','false'],['http.sslVerify','true'],
    ['protocol.allow','never'],['protocol.https.allow','always'],['core.hooksPath',path.join(root,'disabled-hooks')]];
  const git = job.payload.git;
  if (git?.token) {
    const basic = Buffer.from(`${git.username}:${git.token}`).toString('base64');
    gitConfig.push([`http.${app.repo_url}.extraHeader`,`Authorization: Basic ${basic}`]);
  }
  let caFile = null;
  if (git?.caPem) {
    caFile = await contained(root,`git-ca-${job.id}.pem`);
    await fs.writeFile(caFile,[...rootCertificates,git.caPem].join('\n'),{mode:0o600});
    gitConfig.push(['http.sslCAInfo',caFile],['http.sslBackend','openssl']);
  }
  const gitEnv = { ...baseEnv(), GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never',GIT_CONFIG_NOSYSTEM:'1',
    GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_CONFIG_COUNT:String(gitConfig.length) };
  gitConfig.forEach(([key,value],i)=>{gitEnv[`GIT_CONFIG_KEY_${i}`]=key;gitEnv[`GIT_CONFIG_VALUE_${i}`]=value;});
  const secrets = [...Object.values(app.environment),git?.token,git?.token?Buffer.from(`${git.username}:${git.token}`).toString('base64'):''].filter(Boolean);
  try { await command('git',['clone','--depth','1','--single-branch','--branch',app.branch,'--',app.repo_url,release],{env:gitEnv,timeout:600000,log,secrets}); }
  finally { if(caFile)await fs.unlink(caFile); }
  const commit = await command('git',['-C',release,'rev-parse','HEAD'],{env:{...baseEnv(),GIT_CONFIG_NOSYSTEM:'1'}});
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Git did not identify the checked-out commit');
  const appEnv = {...app.environment,...(job.payload.project_type==='go'?{APP_PORT:String(app.port)}:{}),PORT:String(app.port),HOST:'127.0.0.1',HOSTNAME:'127.0.0.1',NODE_ENV:'production'};
  const env = {...baseEnv(),...appEnv};
  await writeEnv(release,appEnv);
  for (const [stage, appCommand] of [['install',app.install_cmd],['build',app.build_cmd]]) {
    if (!appCommand) continue;
    log(`[stage] ${stage}\n`);
    await command(appCommand,[],{cwd:release,env,shell:true,timeout:1800000,log,secrets});
  }
  const releaseState = await contained(root,'release-state',job.id);
  await fs.mkdir(releaseState,{recursive:true,mode:0o700});
  const runner = path.join(releaseState,'runner.cjs');
  // The command is data in JSON. It is never interpolated into JavaScript source.
  await atomicJson(path.join(releaseState,'launch.json'),{command:app.start_cmd,cwd:release,env});
  await fs.writeFile(runner,`'use strict';
const {spawn,spawnSync}=require('node:child_process');
const cfg=require('./launch.json');
const child=spawn(cfg.command,[],{cwd:cfg.cwd,env:cfg.env,shell:true,stdio:'inherit',windowsHide:true,detached:process.platform!=='win32'});
let closing=false;
function stop(){if(closing)return;closing=true;if(child.pid){if(process.platform==='win32')spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:10000});else{try{process.kill(-child.pid,'SIGTERM')}catch{}}}setTimeout(()=>{if(process.platform!=='win32'&&child.pid){try{process.kill(-child.pid,'SIGKILL')}catch{}}process.exit(0)},3000).unref();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);process.on('message',m=>{if(m==='shutdown')stop()});
child.on('error',e=>{console.error(e.message);process.exit(1)});child.on('exit',c=>{if(!closing)process.exit(c??1)});
`,{mode:0o600});
  if(app.start_cmd==='@manager/static') {
    const staticRoot=await findStaticRoot(release);
    await fs.writeFile(runner,`(${serveStatic.toString()})(${JSON.stringify(staticRoot)},${app.port});\n`,{mode:0o600});
  }
  const ecosystem = path.join(releaseState,'ecosystem.config.js');
  const definition = {apps:[{name:`manager-remote-${app.id}`,script:runner,cwd:release,interpreter:process.execPath,
    kill_timeout:10000,shutdown_with_message:true,min_uptime:'10s',max_restarts:10,env:{NODE_ENV:'production'}}]};
  await fs.writeFile(ecosystem,`module.exports=${JSON.stringify(definition)};\n`,{mode:0o600});
  log('[stage] activate\n');
  // Journal precedes ANY change to the live process. Startup recovery restores it after a crash.
  journal.activation={previous,previousApps:JSON.parse(JSON.stringify(applications))};
  await persist();
  try {
    const list=await processList(tools.pm);
    if(list.some(p=>p.name===`manager-remote-${app.id}`))await tools.pm(['delete',`manager-remote-${app.id}`]);
    await availablePort(app.port);
    await tools.pm(['start',ecosystem]);
    log('[stage] health\n');
    await checkHealth(app);
    log('[stage] caddy\n');
    const savedApp={...app,environment:{}}; // Environment values stay in protected per-release files, never telemetry.
    applications[app.id]={app:savedApp,ecosystem,commit};
    await configureProxy(root,caddyConfig(Object.values(applications).map(x=>x.app),path.join(root,'caddy-storage')),tools);
    await atomicJson(path.join(root,'apps.json'),applications);
    await tools.pm(['save','--force']);
    log(`[success] ${commit}\nApplication healthy; Caddy routes loaded. DNS and client certificate trust must be configured.\n`);
    return commit;
  } catch(error) {
    try { await restoreActivation(root,journal,tools,log,dependencies); }
    catch(rollbackError){log(`[rollback failed] ${rollbackError.message}\n`);}
    throw error;
  }
}

function cpuSnapshot(){return os.cpus().reduce((v,c)=>({idle:v.idle+c.times.idle,total:v.total+Object.values(c.times).reduce((a,b)=>a+b,0)}),{idle:0,total:0});}
async function sample(root, tools, prior) {
  const cpu=cpuSnapshot(), delta=cpu.total-prior.total;
  const disk=await fs.statfs(root).catch(()=>null);
  const saved=await readJson(path.join(root,'apps.json'),{});
  let list=[];let proxyError=null;
  try{list=await processList(tools.pm);}catch(error){proxyError=error.message;}
  if(Object.keys(saved).length&&!list.some(p=>p.name==='manager-remote-caddy'&&p.pm2_env?.status==='online'))proxyError='Caddy is not running';
  let caPem=null;
  try{caPem=await fs.readFile(path.join(root,'caddy-storage','pki','authorities','local','root.crt'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  const metrics=sanitizeMetrics({hostname:os.hostname(),platform:process.platform,version:AGENT_VERSION,
    cpuPercent:delta?Math.max(0,Math.min(100,100*(1-(cpu.idle-prior.idle)/delta))):0,
    memoryTotal:os.totalmem(),memoryFree:os.freemem(),diskTotal:disk?disk.blocks*disk.bsize:null,diskFree:disk?disk.bavail*disk.bsize:null,uptime:os.uptime(),
    addresses:Object.values(os.networkInterfaces()).flat().filter(x=>x&&!x.internal).map(x=>x.address),tools:tools.tools,proxyError,
    apps:Object.keys(saved).map(id=>{const p=list.find(p=>p.name===`manager-remote-${id}`);return{id,status:p?.pm2_env?.status||'missing',cpu:p?.monit?.cpu||0,memory:p?.monit?.memory||0};})});
  return {metrics,caPem,cpu};
}

async function enrollCli(root, options) {
  if(!['win32','linux'].includes(process.platform))throw new Error('This agent supports Windows and Linux');
  if(options['enrollment-file']) {
    const setup=await readJson(options['enrollment-file']);
    if(!setup || !ID.test(setup.serverId))throw new Error('Invalid bootstrap enrollment');
    const filename=path.join(root,'agent.json');
    let config=await readJson(filename);
    if(config?.enrolled)throw new Error('This directory already contains an enrolled agent');
    if(!config){config={manager:managerAddress(setup.manager),serverId:setup.serverId,agentToken:randomBytes(32).toString('base64url'),enrolled:false};await atomicJson(filename,config);}
    if(config.serverId!==setup.serverId||config.manager!==managerAddress(setup.manager))throw new Error('Existing enrollment belongs to another Manager server record');
    await request(config,'enroll',{protocol:PROTOCOL_VERSION,serverId:config.serverId,agentToken:config.agentToken,enrollmentToken:setup.enrollmentToken,platform:process.platform});
    config.enrolled=true;await atomicJson(filename,config);console.log('Agent enrolled');return;
  }
  const terminal=createInterface({input:process.stdin,output:process.stdout});
  try {
    const filename=path.join(root,'agent.json');
    let config=await readJson(filename);
    if(config?.enrolled)throw new Error('This directory already contains an enrolled agent');
    if(!config){
      const manager=managerAddress(options.manager||await terminal.question('Manager HTTPS address: '));
      const serverId=options.server||await terminal.question('Server ID: ');
      if(!ID.test(serverId))throw new Error('Invalid server ID');
      config={manager,serverId,agentToken:randomBytes(32).toString('base64url'),enrolled:false};
      await atomicJson(filename,config);
    }
    const enrollmentToken=(await terminal.question('One-time enrollment token: ')).trim();
    await request(config,'enroll',{protocol:PROTOCOL_VERSION,serverId:config.serverId,agentToken:config.agentToken,enrollmentToken,platform:process.platform});
    config.enrolled=true;await atomicJson(filename,config);
    console.log('Enrolled. Run the agent with the same --root directory, then configure it to start at boot.');
  } finally {terminal.close();}
}

async function runAgent(root) {
  const config=await readJson(path.join(root,'agent.json'));
  if(!config?.enrolled)throw new Error('Enroll this agent first');
  const lock=path.join(root,'agent.lock');
  try{await fs.writeFile(lock,String(process.pid),{flag:'wx',mode:0o600});}
  catch(error){
    if(error.code!=='EEXIST')throw error;
    const pid=Number(await fs.readFile(lock,'utf8'));
    let alive=true;try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')alive=false;}
    if(alive)throw new Error('An agent is already running in this directory');
    await fs.unlink(lock);await fs.writeFile(lock,String(process.pid),{flag:'wx',mode:0o600});
  }
  // Updating the agent must not resurrect stopped apps or restart an existing PM2 daemon.
  const tools=await findTools(root);
  const existingProcesses=await processList(tools.pm);
  if(!existingProcesses.length&&await fs.stat(path.join(root,'pm2','dump.pm2')).catch(()=>null))await tools.pm(['resurrect']);
  const journalFile=path.join(root,'current-job.json');
  let journal=await readJson(journalFile), prior=cpuSnapshot(), stopped=false;
  const supervised=process.env.MANAGER_AGENT_SUPERVISOR==='1'&&typeof process.send==='function';
  const send=message=>{if(supervised&&process.connected)process.send(message,()=>{});};
  const onStop=()=>{stopped=true;};process.on('SIGINT',onStop);process.on('SIGTERM',onStop);
  const onMessage=message=>{if(message?.type==='stop')onStop();};
  if(supervised){process.on('message',onMessage);process.on('disconnect',onStop);}
  // Persist reports independently of network connectivity. Manager never retries a running deployment.
  let logSecrets=[];
  const log=text=>{if(journal)journal.log=(journal.log+redact(text,logSecrets)).slice(-120000);};
  let writing=Promise.resolve();
  const persist=()=>{
    const snapshot=JSON.parse(JSON.stringify(journal));
    writing=writing.then(()=>atomicJson(journalFile,snapshot));
    return writing;
  };
  let reportBusy=false;
  const report=async()=>{
    if(!journal||reportBusy)return;reportBusy=true;
    try{
      journal.sequence++;
      const snapshot={id:journal.id,claimToken:journal.claimToken,status:journal.status,log:journal.log,sequence:journal.sequence,commitSha:journal.commitSha,result:journal.result};
      await persist();
      await request(config,'report',snapshot);
      if(snapshot.status!=='running'&&journal?.id===snapshot.id){await fs.unlink(journalFile);journal=null;}
    }finally{reportBusy=false;}
  };
  if(journal?.status==='running'){
    log('[interrupted] Agent restarted. This deployment will not be replayed.\n');
    try{await restoreActivation(root,journal,tools,log);}catch(error){log(`[rollback failed] ${error.message}\n`);}
    journal.status='failed';await persist();
  }
  let heartbeatBusy=false;
  const pulse=async()=>{
    if(heartbeatBusy)return;heartbeatBusy=true;
    try{const data=await sample(root,tools,prior);prior=data.cpu;data.metrics.capabilities=[SETUP_CAPABILITY,...(supervised?[UPDATE_CAPABILITY]:[])];await request(config,'heartbeat',{protocol:PROTOCOL_VERSION,metrics:data.metrics,caPem:data.caPem});send({type:'heartbeat',version:AGENT_VERSION,metrics:data.metrics});}
    finally{heartbeatBusy=false;}
  };
  const describe=error=>console.error(`[agent] ${redact(error.message,[config.agentToken])}`);
  const timer=setInterval(()=>{void pulse().catch(describe);if(journal?.status==='running')void report().catch(describe);},15000);
  console.log(`Manager agent ${AGENT_VERSION} running. Outbound connection to ${config.manager}`);
  try{
    while(!stopped){
      try{
        await pulse();
        if(journal){send({type:'idle',idle:false});await report();await wait(5000);continue;}
        if(stopped)break;
        send({type:'idle',idle:true});
        const {job,protocol}=await request(config,'claim',{});
        if(protocol!==PROTOCOL_VERSION)throw new Error('Agent upgrade required');
        if(!job){await wait(5000);continue;}
        send({type:'idle',idle:false});
        logSecrets=[...jobSecrets(job.payload),config.agentToken];
        journal={id:job.id,appId:job.payload.id,claimToken:job.claimToken,status:'running',sequence:0,log:'',commitSha:null};
        await persist();
        try{
          if (!job.kind || job.kind==='deploy') journal.commitSha=await deploy(root,job,journal,tools,persist,log);
          else if (job.kind==='inspect') { journal.result=await inspectRepository(root,job,tools,log); journal.commitSha=journal.result.commit; }
          else if (job.kind==='database') journal.result=await setupDatabase(root,job,log);
          else if (job.kind==='validate') journal.result=await validateSetup(root,job,tools);
          else throw new Error('Unknown agent operation; upgrade the agent');
          journal.status='success';
        }
        catch(error){log(`[failed] ${error.message}\n`);journal.status='failed';}
        await persist();await report();logSecrets=[];
      }catch(error){describe(error);if(error.status===401){stopped=true;break;}await wait(10000);}
    }
  }finally{
    clearInterval(timer);while(reportBusy||heartbeatBusy)await wait(100);
    await fs.unlink(lock).catch(()=>{});process.off('SIGINT',onStop);process.off('SIGTERM',onStop);
    if(supervised){process.off('message',onMessage);process.off('disconnect',onStop);if(process.connected)process.disconnect();}
  }
}

async function findStaticRoot(release) {
  const roots=[];
  async function visit(relative,depth) {
    const directory=await contained(release,relative);
    for(const entry of await fs.readdir(directory,{withFileTypes:true})) {
      if(entry.isSymbolicLink())throw new Error('Static output cannot contain symlinks');
      if(entry.name==='index.html' && entry.isFile()) roots.push(directory);
      else if(entry.isDirectory() && depth<3)await visit(path.join(relative,entry.name),depth+1);
    }
  }
  await visit('dist',0);
  if(roots.length!==1)throw new Error('Expected one built Angular site under dist. Set a custom start command for a different output layout or SSR.');
  return roots[0];
}

function serveStatic(root,portNumber) {
  const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path');
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2','.woff':'font/woff','.wasm':'application/wasm'};
  const server=http.createServer(async(req,res)=>{
    try {
      if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);return res.end();}
      const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      if(name.includes('\\') || name.includes('\0') || name.split('/').some(part=>part.startsWith('.'))){res.writeHead(404);return res.end();}
      let filename=path.resolve(root,'.'+name),relative=path.relative(root,filename);
      if(relative.startsWith('..')||path.isAbsolute(relative)){res.writeHead(404);return res.end();}
      let cursor=root;
      for(const part of relative.split(path.sep).filter(Boolean)) {cursor=path.join(cursor,part);if((await fs.lstat(cursor).catch(()=>null))?.isSymbolicLink())throw new Error('Linked asset');}
      const stat=await fs.stat(filename).catch(()=>null);
      if(!stat?.isFile()) {if(path.extname(name)){res.writeHead(404);return res.end();}filename=path.join(root,'index.html');}
      const data=await fs.readFile(filename);
      res.writeHead(200,{'Content-Type':types[path.extname(filename)]||'application/octet-stream','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:data);
    }catch{res.writeHead(404);res.end();}
  });
  server.listen(portNumber,'127.0.0.1');
  return server;
}

function jobSecrets(payload) {
  const database = payload.database || {};
  const values = [...Object.values(payload.environment || {}),payload.git?.token,database.password,database.adminPassword,
    payload.git?.token ? Buffer.from(`${payload.git.username}:${payload.git.token}`).toString('base64') : ''].filter(x=>typeof x==='string' && x);
  return [...values,...values.flatMap(value=>{try{return [encodeURIComponent(value)];}catch{return [];}}),...values.map(x=>x.replace(/'/g,"''"))];
}

async function cloneForSetup(root, job, log, command = run) {
  const app = validateApp(job.payload);
  if (!ID.test(job.id) || !ID.test(job.payload.id)) throw new Error('Invalid setup identifier');
  const destination = await contained(root,'setup',job.payload.id,job.id);
  await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});
  if (await fs.lstat(destination).catch(()=>null)) throw new Error('Inspection directory already exists; refusing to replay');
  const config = [['credential.helper',''],['http.extraHeader',''],['http.followRedirects','false'],['http.sslVerify','true'],
    ['protocol.allow','never'],['protocol.https.allow','always'],['core.hooksPath',path.join(root,'disabled-hooks')]];
  const git = job.payload.git;
  if (git?.token) config.push([`http.${app.repo_url}.extraHeader`,`Authorization: Basic ${Buffer.from(`${git.username}:${git.token}`).toString('base64')}`]);
  const ca = git?.caPem ? await contained(root,`setup-ca-${job.id}.pem`) : null;
  if (ca) { await fs.writeFile(ca,[...rootCertificates,git.caPem].join('\n'),{mode:0o600}); config.push(['http.sslCAInfo',ca],['http.sslBackend','openssl']); }
  const env = {...baseEnv(),GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_CONFIG_COUNT:String(config.length)};
  config.forEach(([key,value],i)=>{env[`GIT_CONFIG_KEY_${i}`]=key;env[`GIT_CONFIG_VALUE_${i}`]=value;});
  log('[source] Cloning the selected branch on this server. No repository scripts are executed.\n');
  try { await command('git',['clone','--depth','1','--single-branch','--branch',app.branch,'--',app.repo_url,destination],{env,timeout:600000,log,secrets:jobSecrets(job.payload)}); }
  finally { if(ca)await fs.unlink(ca); }
  const commit = await command('git',['-C',destination,'rev-parse','HEAD'],{env});
  if(!/^[a-f0-9]{40,64}$/.test(commit))throw new Error('Git did not identify the inspected commit');
  return {destination,commit};
}

async function manifest(root, name) {
  const filename = await contained(root,name);
  const stat = await fs.lstat(filename).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(!stat)return null;
  if(!stat.isFile() || stat.size>1024*1024)throw new Error(`Invalid or oversized ${name}`);
  return fs.readFile(filename,'utf8');
}

async function detectFramework(root, platform = process.platform, appPort = 3000) {
  const pkgText = await manifest(root,'package.json'), composerText = await manifest(root,'composer.json');
  const pkg = pkgText ? JSON.parse(pkgText) : null, composer = composerText ? JSON.parse(composerText) : null;
  const deps = {...pkg?.dependencies,...pkg?.devDependencies};
  const framework = composer?.require?.['laravel/framework'] ? 'laravel' : await manifest(root,'go.mod') !== null ? 'go' :
    deps.next ? 'next' : deps['@angular/core'] || await manifest(root,'angular.json') !== null ? 'angular' : pkg ? 'node' : null;
  const packageManager = pkg ? await manifest(root,'pnpm-lock.yaml') !== null ? 'pnpm' : await manifest(root,'yarn.lock') !== null ? 'yarn' : 'npm' : null;
  const locked = pkg && (await manifest(root,'package-lock.json') !== null || await manifest(root,'npm-shrinkwrap.json') !== null);
  const classicYarn = packageManager==='yarn' && (await manifest(root,'yarn.lock')).includes('yarn lockfile v1');
  const install = packageManager === 'pnpm' ? 'pnpm install --frozen-lockfile --prod=false' : packageManager === 'yarn' ? classicYarn ? 'yarn install --frozen-lockfile --production=false' : 'yarn install --immutable' : locked ? 'npm ci --include=dev' : 'npm install --include=dev';
  const runner = packageManager || 'npm';
  const commands = {install_cmd: pkg ? install : '', build_cmd: pkg?.scripts?.build ? `${runner} run build` : '', start_cmd: pkg?.scripts?.start ? `${runner} run start` : ''};
  if(framework==='go') Object.assign(commands,{install_cmd:'go mod download',build_cmd:`go build -o ${platform==='win32'?'app.exe':'app'} .`,start_cmd:platform==='win32'?'.\\app.exe':'./app'});
  if(framework==='laravel') Object.assign(commands,{install_cmd:'composer install --no-dev --optimize-autoloader',build_cmd:'php artisan config:cache',start_cmd:`php artisan serve --host=127.0.0.1 --port=${appPort} --no-reload`});
  if(framework==='angular') commands.start_cmd='@manager/static';
  return {framework,commands,packageManager};
}

async function inspectTools(tools, command = run) {
  const result = {...tools.tools};
  for(const name of ['npm','pnpm','yarn','go','php','composer','psql','mysql','mariadb']) {
    try {
      // These are fixed tool names, never repository-controlled shell text.
      result[name] = (await command(name,[name==='go'?'version':'--version'],{shell:process.platform==='win32' && ['npm','pnpm','yarn','composer'].includes(name),timeout:10000})).split(/\r?\n/)[0].slice(0,200);
    } catch { result[name]=null; }
  }
  return result;
}

async function inspectRepository(root, job, tools, log, dependencies = {}) {
  const {destination,commit} = await cloneForSetup(root,job,log,dependencies.run || run);
  const detection = await detectFramework(destination,dependencies.platform || process.platform,job.payload.port);
  const installed = await inspectTools(tools,dependencies.run || run);
  log(`[source] ${detection.framework || 'No supported framework'} detected. Commit ${commit.slice(0,12)}.\n`);
  return {...detection,commit,tools:installed};
}

function validateDatabase(input) {
  if(!input || !['create','existing'].includes(input.mode) || !['postgresql','mysql','mariadb'].includes(input.provider))throw new Error('Choose PostgreSQL, MySQL or MariaDB and a database action');
  const host=requireText(input.host,'database host',253);
  if(!net.isIP(host) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host))throw new Error('Use a database hostname or IP address');
  const number=Number(input.port);
  if(!Number.isInteger(number)||number<1||number>65535)throw new Error('Invalid database port');
  const identifier=(value,label,max=63)=>{if(typeof value!=='string'||!new RegExp(`^[a-zA-Z_][a-zA-Z0-9_]{0,${max-1}}$`).test(value))throw new Error(`Invalid ${label}: use letters, numbers and underscores`);return value;};
  const password=(value)=>{if(typeof value!=='string'||!value||value.length>4096||/[\0\r\n]/.test(value)||!value.isWellFormed())throw new Error('A database password is required (maximum 4096 characters, one valid Unicode line)');return value;};
  const result={mode:input.mode,provider:input.provider,host,port:number,database:identifier(input.database,'database name'),username:identifier(input.username,'database user',input.provider==='postgresql'?63:32),password:password(input.password),tls:input.tls===true,managed:input.managed===true || input.mode==='create'};
  if(input.mode==='create') {
    result.adminUsername=identifier(input.adminUsername,'database administrator');result.adminPassword=password(input.adminPassword);
    if(input.provider!=='postgresql' && !['127.0.0.1','localhost','::1'].includes(host))throw new Error('Create MySQL/MariaDB databases on this server using a loopback address; attach remote databases with an existing account');
  }
  return result;
}

function databaseEnvironment(input) {
  const d=validateDatabase({...input,mode:'existing'}),host=net.isIP(d.host)===6?`[${d.host}]`:d.host;
  const url=`${d.provider==='postgresql'?'postgresql':'mysql'}://${encodeURIComponent(d.username)}:${encodeURIComponent(d.password)}@${host}:${d.port}/${encodeURIComponent(d.database)}${d.provider==='postgresql'?`?sslmode=${d.tls?'verify-full':'disable'}`:''}`;
  return {DATABASE_URL:url,DATABASE_HOST:d.host,DATABASE_PORT:String(d.port),DATABASE_NAME:d.database,DATABASE_USER:d.username,DATABASE_PASSWORD:d.password,
    DB_CONNECTION:d.provider==='postgresql'?'pgsql':'mysql',DB_HOST:d.host,DB_PORT:String(d.port),DB_DATABASE:d.database,DB_USERNAME:d.username,DB_PASSWORD:d.password,
    ...(d.provider==='postgresql'?{PGSSLMODE:d.tls?'verify-full':'disable'}:{})};
}

async function setupDatabase(root, job, log, dependencies = {}) {
  if(!ID.test(job.id)||!ID.test(job.payload.id))throw new Error('Invalid database job identifier');
  const d=validateDatabase(job.payload.database),command=dependencies.run || run;
  const secrets=jobSecrets(job.payload);
  const sqlString=value=>`'${value.replace(/'/g,"''")}'`;
  async function sql(statement, admin=false, database=d.database) {
    const username=admin?d.adminUsername:d.username,password=admin?d.adminPassword:d.password;
    if(d.provider==='postgresql')return command('psql',['-X','--no-password','--set','ON_ERROR_STOP=1','--tuples-only','--no-align','--host',d.host,'--port',String(d.port),'--username',username,'--dbname',database],{
      env:{...baseEnv(),PGPASSWORD:password,PGSSLMODE:d.tls?'verify-full':'disable',PGCONNECT_TIMEOUT:'10',PGOPTIONS:'-c statement_timeout=15000'},
      input:`SET standard_conforming_strings=on;\n${statement}\n`,timeout:30000,secrets});
    const filename=await contained(root,`db-client-${job.id}.cnf`);
    const quoted=value=>`"${String(value).replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`;
    try {
      const tls=d.provider==='mysql'?`ssl-mode=${d.tls?'VERIFY_IDENTITY':'DISABLED'}`:d.tls?'ssl\nssl-verify-server-cert':'skip-ssl';
      await fs.writeFile(filename,`[client]\nhost=${quoted(d.host)}\nport=${d.port}\nuser=${quoted(username)}\npassword=${quoted(password)}\nprotocol=tcp\n${tls}\n`,{mode:0o600,flag:'wx'});
      return await command(d.provider==='mysql'?'mysql':'mariadb',[`--defaults-extra-file=${filename}`,'--batch','--skip-column-names','--raw',...(database?['--database',database]:[])],{input:`SET SESSION sql_mode='NO_BACKSLASH_ESCAPES';\n${statement}\n`,timeout:30000,secrets});
    } finally { await fs.unlink(filename).catch(()=>{}); }
  }
  if(d.mode==='create') {
    log('[database] Creating an isolated database and application account. Existing names are never reused or altered.\n');
    if(d.provider==='postgresql') {
      const existing=await sql(`SELECT 1 FROM pg_database WHERE datname=${sqlString(d.database)} UNION ALL SELECT 1 FROM pg_roles WHERE rolname=${sqlString(d.username)};`,true,'postgres');
      if(/(?:^|\n)1(?:\n|$)/.test(existing))throw new Error('Database or role already exists. Use Test saved connection to recover a partial creation, or attach an existing database.');
      await sql(`CREATE ROLE "${d.username}" LOGIN PASSWORD ${sqlString(d.password)} NOSUPERUSER NOCREATEDB NOCREATEROLE;`,true,'postgres');
      await sql(`CREATE DATABASE "${d.database}" OWNER "${d.username}";`,true,'postgres');
      await sql(`REVOKE ALL ON DATABASE "${d.database}" FROM PUBLIC;`,true,'postgres');
      await sql(`REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE, CREATE ON SCHEMA public TO "${d.username}";`,true,d.database);
    } else {
      const existing=await sql(`SELECT 1 FROM information_schema.schemata WHERE schema_name=${sqlString(d.database)} UNION ALL SELECT 1 FROM mysql.user WHERE user=${sqlString(d.username)};`,true,'');
      if(/(?:^|\n)1(?:\n|$)/.test(existing))throw new Error('Database or user already exists. Use Test saved connection to recover a partial creation, or attach an existing database.');
      await sql(`CREATE USER ${sqlString(d.username)}@'localhost' IDENTIFIED BY ${sqlString(d.password)};\nCREATE DATABASE \`${d.database}\`;\nGRANT ALL PRIVILEGES ON \`${d.database}\`.* TO ${sqlString(d.username)}@'localhost';`,true,'');
    }
  }
  const checked=await sql('SELECT 1;');
  if(!/(?:^|\n)1(?:\n|$)/.test(checked))throw new Error('Database did not return a successful test query');
  if(d.managed && d.provider==='postgresql') {
    const privateDatabase=await sql(`SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND pg_get_userbyid(d.datdba)=current_user AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a WHERE a.grantee=0 AND a.privilege_type IN ('CONNECT','CREATE','TEMPORARY'));`);
    if(!/(?:^|\n)1(?:\n|$)/.test(privateDatabase))throw new Error('Database creation is incomplete: verify the app owns its database and revoke PUBLIC access before testing the saved connection again');
  }
  log('[database] Application credentials verified from this server.\n');
  return {ok:true};
}

async function validateSetup(root, job, tools, dependencies = {}) {
  const app=validateApp(job.payload);
  const installed=await inspectTools(tools,dependencies.run || run);
  const framework=job.payload.project_type;
  const required=['git','caddy','pm2',...(framework==='go'?['go']:framework==='laravel'?['php','composer']:['node']),...(job.payload.packageManager?[job.payload.packageManager]:[])];
  const missing=required.filter(name=>!installed[name]);
  if(missing.length)throw new Error(`Install these tools for the agent account: ${missing.join(', ')}`);
  const apps=await readJson(path.join(root,'apps.json'),{});
  if(!apps[job.payload.id] || apps[job.payload.id].app.port!==app.port)await (dependencies.checkPort || checkPort)(app.port);
  if(app.ip_port && (!apps[job.payload.id] || apps[job.payload.id].app.ip_port!==app.ip_port))await (dependencies.checkPort || checkPort)(app.ip_port);
  if(job.payload.database)await setupDatabase(root,{...job,payload:{...job.payload,database:{...job.payload.database,mode:'existing'}}},()=>{},dependencies);
  return {ok:true};
}

async function main(){
  if(Number(process.versions.node.split('.')[0])<22)throw new Error('Install Node.js 22 or later');
  if(process.argv.length===3&&process.argv[2]==='version'){console.log(JSON.stringify({version:AGENT_VERSION,protocol:PROTOCOL_VERSION,supervisorProtocol:1}));return;}
  const [action,...args]=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i+=2){if(!['--root','--manager','--server','--enrollment-file'].includes(args[i])||!args[i+1])throw new Error('Use --root, --manager, --server and --enrollment-file options');options[args[i].slice(2)]=args[i+1];}
  if(!['enroll','run'].includes(action)||!options.root)throw new Error('Usage: node manager-agent.cjs enroll|run --root <dedicated absolute folder> [--manager https://manager.example.edu --server <id>]');
  if(!path.isAbsolute(options.root))throw new Error('--root must be an absolute path');
  await fs.mkdir(options.root,{recursive:true,mode:0o700});
  const root=await fs.realpath(options.root);
  if(root===path.parse(root).root)throw new Error('Choose a dedicated agent folder, not a drive root');
  // On Windows, ACL inheritance must be explicitly removed; Unix mode bits do not protect files there.
  if(process.platform==='win32'){
    const account=(await run('whoami.exe')).trim();
    await run('icacls.exe',[root,'/inheritance:r','/grant:r',`${account}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F']);
  }else await fs.chmod(root,0o700);
  if(action==='enroll')await enrollCli(root,options);else await runAgent(root);
}

module.exports={PROTOCOL_VERSION,AGENT_VERSION,SETUP_CAPABILITY,UPDATE_CAPABILITY,validateApp,sanitizeMetrics,redact,streamRedactor,caddyConfig,managerAddress,contained,run,request,deploy,restoreActivation,healthy,atomicJson,readJson,enrollCli,detectFramework,inspectRepository,validateDatabase,databaseEnvironment,setupDatabase,validateSetup,jobSecrets,findStaticRoot,serveStatic};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
