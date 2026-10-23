const fs=require('node:fs');
const path=require('node:path');
const {createRequire}=require('node:module');
const S=require('./manager-update-state.cjs');
const {processes}=require('./manager-update-worker.cjs');
async function register(root,stateRoot,bootstrapFile,taskName,managerUrl='',caCertificate='') {
  root=path.resolve(root);stateRoot=path.resolve(stateRoot);
  if(path.parse(root).root.toLowerCase()!==path.parse(stateRoot).root.toLowerCase())throw new Error('Recovery and Manager must be on the same volume for atomic activation');
  const boot=S.json(bootstrapFile);
  const pm2PackageRoot=boot.pm2PackageRoot || path.join(path.dirname(boot.pm2),'node_modules/pm2');
  const pm2Home=boot.pm2Home || path.join(process.env.ProgramData,'Manager/pm2');
  const nodeExe=boot.nodeExe || boot.node;
  const c={managerRoot:root,stateRoot,nodeExe,pm2PackageRoot,pm2Home};
  const existing=S.currentJob(c);if(existing&&!S.TERMINAL.includes(existing.state.phase))throw new Error('Finish or recover the current update before registering again');
  const rows=await processes(c),manager=rows.find(p=>p.name==='manager');
  if(!manager || path.resolve(manager.pm2_env.pm_cwd).toLowerCase()!==root.toLowerCase())throw new Error('The running Manager does not match this folder');
  if(path.resolve(manager.pm2_env.PM2_HOME).toLowerCase()!==path.resolve(pm2Home).toLowerCase())throw new Error('PM2 home does not match the registered daemon');
  // Bootstrap uses its verified standalone runtime; older Managers lack these tools.
  const runtimeRoot=path.resolve(__dirname,'..');
  const req=createRequire(path.join(runtimeRoot,'package.json'));
  const env=req('dotenv').parse(fs.readFileSync(path.join(root,'.env.local')));
  let pgBin=env.PG_BIN_PATH;
  if(!pgBin) {
    const client=new (req('pg').Client)(env.DATABASE_URL?{connectionString:env.DATABASE_URL}:{host:env.DATABASE_HOST,port:Number(env.DATABASE_PORT||5432),database:env.DATABASE_NAME,user:env.DATABASE_USER,password:env.DATABASE_PASSWORD});
    await client.connect();
    try {pgBin=(await client.query("select value from settings where key='PG_BIN_PATH'")).rows[0]?.value}finally{await client.end()}
  }
  if(!pgBin && process.platform==='win32') {
    const parent=path.join(process.env.ProgramFiles||'C:\\Program Files','PostgreSQL');
    if(fs.existsSync(parent))for(const version of fs.readdirSync(parent).filter(v=>/^\d+(\.\d+)?$/.test(v)).sort((a,b)=>Number(b)-Number(a))) {
      const candidate=path.join(parent,version,'bin');if(fs.existsSync(path.join(candidate,'pg_dump.exe'))){pgBin=candidate;break;}
    }
  }
  c.pgDump=path.join(pgBin||'',process.platform==='win32'?'pg_dump.exe':'pg_dump');
  if(!path.isAbsolute(c.pgDump)||!fs.existsSync(c.pgDump))throw new Error('Configure PostgreSQL tools in Settings → Backups before enabling updates');
  c.port=Number(env.MANAGER_PORT||manager.pm2_env.PORT||4000);
  c.caddyConfig=env.CADDYFILE_PATH||path.join(env.CADDY_PATH||path.dirname(root),'Caddyfile');
  c.managerUrl='https://'+(env.MANAGER_DOMAIN||manager.pm2_env.MANAGER_DOMAIN||'deploy.smartcloudgh.com');
  const reportFile=path.join(process.env.ProgramData||'', 'Manager/install-report.json');
  if(fs.existsSync(reportFile)) {
    const report=S.json(reportFile);
    if(path.resolve(report.managerRoot).toLowerCase()===root.toLowerCase()) {
      if(report.managerUrl)c.managerUrl=report.managerUrl;
      if(report.localCaCertificate)c.caCertificate=report.localCaCertificate;
    }
  }
  if(managerUrl){const url=new URL(managerUrl);if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash)throw new Error('Manager URL must be an HTTPS origin');c.managerUrl=url.origin;}
  if(caCertificate){if(!path.isAbsolute(caCertificate)||!fs.existsSync(caCertificate))throw new Error('CA certificate must be an existing absolute path');c.caCertificate=caCertificate;}
  c.recoveryTask=taskName;
  c.registeredAt=new Date().toISOString();
  const runner=path.join(stateRoot,'runner');fs.mkdirSync(runner,{recursive:true});
  for(const file of ['manager-update-worker.cjs','manager-update-state.cjs'])fs.copyFileSync(path.join(__dirname,file),path.join(runner,file));
  const copied=new Set();
  function copyDependency(name,from=runtimeRoot) {
    if(copied.has(name))return;copied.add(name);
    let manifest;
    try {manifest=require.resolve(name+'/package.json',{paths:[from]});}catch(error){
      if(error.code!=='ERR_PACKAGE_PATH_NOT_EXPORTED')throw error;
      let folder=path.dirname(require.resolve(name,{paths:[from]}));
      while(folder!==path.dirname(folder)) {
        const file=path.join(folder,'package.json');
        if(fs.existsSync(file)&&S.json(file).name===name){manifest=file;break;}
        folder=path.dirname(folder);
      }
      if(!manifest)throw new Error('Cannot locate recovery dependency '+name);
    }
    const source=path.dirname(manifest),dest=path.join(runner,'node_modules',name);
    fs.cpSync(source,dest,{recursive:true});
    const p=S.json(manifest);for(const dependency of Object.keys(p.dependencies||{}))copyDependency(dependency,source);
  }
  copyDependency('pg');copyDependency('dotenv');
  fs.mkdirSync(path.join(stateRoot,'jobs'),{recursive:true});
  S.atomic(path.join(root,'.manager-updater.json'),c);
  console.log(JSON.stringify({configured:true,root,stateRoot,port:c.port,recoveryTask:taskName}));
}
if(require.main===module)register(...process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={register};
