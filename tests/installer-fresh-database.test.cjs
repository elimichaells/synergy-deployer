const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {execFile}=require('node:child_process'),{promisify}=require('node:util'),{randomBytes}=require('node:crypto');
const exec=promisify(execFile),q=s=>"'"+s.replaceAll("'","''")+"'";
const freePort=()=>new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port))})});
const bin=process.env.MANAGER_INSTALL_TEST_PG_BIN;
test('fresh Manager initializes isolated databases and administrator credentials without adopting or changing existing data',{skip:process.platform!=='win32'||!bin,timeout:120000},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-fresh-database-')),started=[],clients=[];
  const password=randomBytes(24).toString('hex'),appPassword=randomBytes(24).toString('hex'),adminPassword=randomBytes(24).toString('hex');
  const env={...process.env,PGPASSWORD:password,PGCONNECT_TIMEOUT:'5'};
  for(const key of Object.keys(env))if(/^(DATABASE_|APP_POSTGRES_|ADMIN_|PGPASSFILE$)/i.test(key))delete env[key];
  const run=(file,args,options={})=>exec(file,args,{windowsHide:true,timeout:30000,maxBuffer:1024*1024,env,...options});
  t.after(async()=>{
    await Promise.all(clients.map(c=>c.end()));
    for(const data of started.reverse())await run(path.join(bin,'pg_ctl.exe'),['-D',data,'-w','-m','fast','stop']);
    if(!path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep))throw Error('Unexpected fixture directory');
    await fs.rm(root,{recursive:true,force:true});
  });
  const passwordFile=path.join(root,'init-password');await fs.writeFile(passwordFile,password);
  const ports=[];
  for(const label of ['control','applications']){
    const data=path.join(root,label),port=await freePort();
    await run(path.join(bin,'initdb.exe'),['-D',data,'-U','manager_fixture_admin','-A','scram-sha-256','--encoding=UTF8','--pwfile='+passwordFile]);
    await fs.appendFile(path.join(data,'postgresql.conf'),`\nlisten_addresses='127.0.0.1'\nport=${port}\n`);
    await run(path.join(bin,'pg_ctl.exe'),['-D',data,'-l',path.join(root,label+'.log'),'-w','start']);started.push(data);ports.push(port);
  }
  await fs.unlink(passwordFile);
  const {Client}=require('pg');
  const connect=async(database,user='manager_fixture_admin',secret=password)=>{const c=new Client({host:'127.0.0.1',port:ports[0],database,user,password:secret});await c.connect();clients.push(c);return c};
  const control=await connect('postgres');
  const create=async(database,role,secret)=>{
    const script=`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);. ${q(path.resolve(__dirname,'../scripts/installer-database-policy.ps1'))};Get-ManagerControlDatabaseSql ${q(database)} ${q(role)} ${q(secret)}`;
    const sql=(await run('powershell.exe',['-NoProfile','-NonInteractive','-OutputFormat','Text','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')])).stdout;
    const file=path.join(root,'create.sql');await fs.writeFile(file,sql);
    await run(path.join(bin,'psql.exe'),['-X','-w','-h','127.0.0.1','-p',String(ports[0]),'-U','manager_fixture_admin','-d','postgres','-v','ON_ERROR_STOP=1','-f',file]);
  };
  await create('manager_fresh','manager_fresh_app',appPassword);
  const initEnv={...env,DATABASE_HOST:'127.0.0.1',DATABASE_PORT:String(ports[0]),DATABASE_NAME:'manager_fresh',DATABASE_USER:'manager_fresh_app',DATABASE_PASSWORD:appPassword,ADMIN_EMAIL:'admin@fixture.test',ADMIN_NAME:'Fixture administrator',ADMIN_PASSWORD:adminPassword,MANAGER_ENCRYPTION_KEY:randomBytes(32).toString('hex'),APP_POSTGRES_HOST:'127.0.0.1',APP_POSTGRES_PORT:String(ports[1]),APP_POSTGRES_ADMIN_USER:'manager_fixture_admin',APP_POSTGRES_ADMIN_PASSWORD:password};
  await run(process.execPath,[path.resolve(__dirname,'../scripts/initialize-manager.js')],{cwd:path.resolve(__dirname,'..'),env:initEnv});
  const application=await connect('manager_fresh','manager_fresh_app',appPassword);
  const account=(await application.query("select role,status,password_hash from users where email='admin@fixture.test'")).rows[0];
  assert.equal(account.role,'admin');assert.equal(account.status,'active');assert.ok(await require('bcrypt').compare(adminPassword,account.password_hash));
  const provider=(await application.query('select port,last_status,password_ciphertext from data_connections')).rows[0];
  assert.equal(provider.port,ports[1]);assert.equal(provider.last_status,'healthy');assert.match(provider.password_ciphertext,/^v1:/);
  assert.equal((await control.query("select rolsuper from pg_roles where rolname='manager_fresh_app'")).rows[0].rolsuper,false);
  await assert.rejects(create('another_database','manager_fresh_app','must-not-rotate'),/already exists/);
  await assert.rejects(create('manager_fresh','another_role','must-not-create'),/already exists/);
  assert.equal((await control.query("select 1 from pg_roles where rolname='another_role'")).rowCount,0);
  const preserved=await connect('manager_fresh','manager_fresh_app',appPassword);
  assert.equal((await preserved.query('select count(*)::int as n from users')).rows[0].n,1);
});
