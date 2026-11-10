'use strict';
const path=require('node:path');
const SERVICES={phpmyadmin:{tool:'phpmyadmin'},postgresql:{tool:'psql',port:5432,match:/postgres/i},mysql:{tool:'mysql',port:3306,match:/mysql|maria/i},mariadb:{tool:'mariadb',port:3306,match:/mysql|maria/i},node:{tool:'node'},git:{tool:'git'},caddy:{tool:'caddy',match:/caddy/i},pm2:{tool:'pm2'},go:{tool:'go'},php:{tool:'php'},python:{tool:'python'},composer:{tool:'composer'},sling:{tool:'sling'},angular:{tool:'ng'},mongodb:{tool:'mongod',port:27017,match:/mongo/i},sqlserver:{tool:'sqlcmd',port:1433,match:/mssql|sqlservr/i},redis:{tool:'redis',port:6379,match:/redis|memurai/i}};
function absolute(value,platform,label){
  if(typeof value!=='string'||!value||value.length>1024||/[\x00-\x1f\x7f"<>|*?]/.test(value)||platform==='win32'&&(/[;]/.test(value)||value.slice(2).includes(':'))||platform==='linux'&&value.includes(':'))throw Error('Enter an absolute '+label+' path');
  const p=platform==='win32'?path.win32:path.posix;
  if(!p.isAbsolute(value)||platform==='win32'&&!/^[a-z]:[\\/]/i.test(value)||value===p.parse(value).root)throw Error('Use a local absolute '+label+' path, not a drive root');
  return p.normalize(value);
}
function servicePlan(raw,platform){
  if(!['win32','linux'].includes(platform)||!raw||!SERVICES[raw.service]||!['install','reuse','install-version'].includes(raw.mode))throw Error('Choose a supported service and installation mode');
  if(raw.service==='phpmyadmin'&&raw.mode!=='install')throw Error('The private database browser uses its own installation. Existing web clients and PHP configuration are preserved.');
  const version=raw.mode==='install-version'?String(raw.version||''):'';
  if(raw.mode==='install-version'&&(!['node','go','php'].includes(raw.service)||!/^\d+\.\d+\.\d+$/.test(version)||platform==='linux'&&raw.service==='php'))throw Error('Choose a supported runtime version');
  const spec=SERVICES[raw.service],port=spec.port?Number(raw.port||spec.port):0;
  if(spec.port&&(!Number.isInteger(port)||port<1024||port>65535||[2019,2029].includes(port)))throw Error('Choose an unused database port between 1024 and 65535');
  return {service:raw.service,mode:raw.mode,version,path:raw.mode==='reuse'?absolute(raw.path,platform,'executable'):'',port,
    agentRoot:absolute(raw.agentRoot||(platform==='win32'?'C:\\ProgramData\\ManagerAgent':'/var/lib/manager-agent'),platform,'agent'),
    dataRoot:absolute(raw.dataRoot||(platform==='win32'?'C:\\ProgramData\\ManagerServices':'/var/lib/manager-services'),platform,'service data')};
}
function verifyServicePlan(plan,inventory){
  const spec=SERVICES[plan.service];
  if(!spec||!inventory.portsKnown)throw Error('Inspect listening ports before provisioning');
  const candidates=inventory.tools[spec.tool]||[];
  if(plan.service==='phpmyadmin')return;
  if(plan.mode==='install-version')return; // A new version has its own directory and never replaces the server default.
  if(plan.mode==='reuse'){
    if(!candidates.some(x=>x.compatible&&(inventory.platform==='win32'?x.path.toLowerCase()===plan.path.toLowerCase():x.path===plan.path)))throw Error('Inspect and verify this executable path before reusing it');
    return;
  }
  if(plan.service==='sqlserver'&&inventory.platform!=='win32')throw Error('Reuse an existing SQL Server installation on Linux. Automatic SQL Server Express installation requires Windows x64.');
  if(plan.service==='redis'&&inventory.platform!=='linux')throw Error('Reuse a production-licensed Memurai installation or connect an existing Redis server in Storage. The Windows developer edition is not installed automatically.');
  if(plan.service==='mongodb'&&inventory.platform==='linux'){
    const d=inventory.distribution,supported=d?.id==='ubuntu'&&['22.04','24.04'].includes(d.version)||d?.id==='debian'&&d.version==='12'&&inventory.arch==='x64';
    if(!supported)throw Error('Automatic MongoDB installation supports Ubuntu 22.04/24.04 or Debian 12 x64. Reuse an existing MongoDB path on this distribution.');
  }
  if(!spec.port&&candidates.length || spec.match&&inventory.services.some(s=>spec.match.test(s.name+' '+s.executable)))throw Error('An existing installation was found. Choose Reuse; existing installations are never replaced.');
  if(spec.port&&inventory.ports.includes(plan.port))throw Error('This database port is already in use');
  if(plan.service==='caddy'&&inventory.ports.some(p=>[80,443,2019,2029].includes(p)))throw Error('Web ports are occupied. Reuse and integrate the existing proxy; its sites will not be replaced.');
}
module.exports={SERVICES,servicePlan,verifyServicePlan,absolute};
