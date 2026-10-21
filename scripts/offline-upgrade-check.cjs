const fs=require('node:fs'),path=require('node:path');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
async function inspect(root){
 const report=read(path.join(root,'install-report.json')),boot=read(path.join(root,'pm2-startup.json'));
 const {readPm2}=require(path.join(report.managerRoot,'scripts/server-monitor.cjs'));
 const rows=await readPm2({pm2PackageRoot:path.join(path.dirname(boot.pm2),'node_modules/pm2')});
 const managers=rows.filter(row=>row.name==='manager');
 const manager=managers[0];
 if(managers.length!==1||manager.pm2_env.status!=='online'||path.resolve(manager.pm2_env.pm_exec_path).toLowerCase()!==path.resolve(report.managerRoot,'node_modules/next/dist/bin/next').toLowerCase()||path.resolve(manager.pm2_env.pm_cwd).toLowerCase()!==path.resolve(report.managerRoot).toLowerCase())throw Error('The expected installed Manager is not running in PM2');
 if(manager.pm2_env.PM2_HOME&&path.resolve(manager.pm2_env.PM2_HOME).toLowerCase()!==path.resolve(root,'pm2').toLowerCase())throw Error('Unexpected PM2 daemon home');
 const env=require(path.join(report.managerRoot,'node_modules/dotenv')).parse(fs.readFileSync(path.join(report.managerRoot,'.env.local')));
 if(env.MANAGER_OFFLINE_INSTALL!=='1')throw Error('This upgrade is for an existing offline Manager installation');
 const {Client}=require(path.join(report.managerRoot,'node_modules/pg'));
 const client=new Client({...env.DATABASE_URL?{connectionString:env.DATABASE_URL}:{host:env.DATABASE_HOST,port:Number(env.DATABASE_PORT||5432),database:env.DATABASE_NAME,user:env.DATABASE_USER,password:env.DATABASE_PASSWORD},connectionTimeoutMillis:10000});
 await client.connect();try{
  for(const table of ['deployments','runtime_jobs']){
   const result=await client.query(`select count(*)::int as active from ${table} where status in ('queued','running')`);
   if(result.rows[0].active)throw Error('Finish active deployments and dependency jobs before upgrading Manager');
  }
 }finally{await client.end()}
 const pma=rows.filter(row=>row.name==='manager-phpmyadmin'&&row.pm2_env.status==='online');
 if(pma.some(row=>path.resolve(row.pm2_env.pm_exec_path).toLowerCase()!==path.resolve(report.managerRoot,'scripts/pm2-phpmyadmin-runner.js').toLowerCase()))throw Error('Unexpected phpMyAdmin process owner');
 return {managerRoot:report.managerRoot,phpMyAdminRunning:pma.length>0,version:read(path.join(report.managerRoot,'package.json')).version};
}
if(require.main===module)inspect(process.argv[2]).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1});
module.exports={inspect};
