// Runs remote API integration tests in a disposable, loopback-only PostgreSQL cluster.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {execFile,spawn}=require('node:child_process'),{promisify}=require('node:util'),{randomBytes}=require('node:crypto');
const exec=promisify(execFile),bin=process.argv[2];
(async()=>{
  if(!bin||!path.isAbsolute(bin))throw Error('Pass an absolute PostgreSQL bin directory');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-parity-db-')),data=path.join(root,'data'),password=randomBytes(24).toString('hex');let started=false;
  const suffix=process.platform==='win32'?'.exe':'',run=(name,args)=>exec(path.join(bin,name+suffix),args,{windowsHide:true,timeout:30000});
  try{
    const passfile=path.join(root,'password');await fs.writeFile(passfile,password,{mode:0o600});
    await run('initdb',['-D',data,'-U','fixture_admin','-A','scram-sha-256','--encoding=UTF8','--pwfile='+passfile]);await fs.unlink(passfile);
    const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
    await fs.appendFile(path.join(data,'postgresql.conf'),`\nlisten_addresses='127.0.0.1'\nport=${port}\n`);
    await run('pg_ctl',['-D',data,'-l',path.join(root,'postgres.log'),'-w','start']);started=true;
    const {Client}=require('pg'),client=new Client({host:'127.0.0.1',port,user:'fixture_admin',password,database:'postgres'});
    await client.connect();try{await client.query('create database manager_remote_test_parity')}finally{await client.end()}
    const env={...process.env,MANAGER_REMOTE_TEST_PG_BIN:bin,MANAGER_REMOTE_TEST_DATABASE_URL:`postgresql://fixture_admin:${password}@127.0.0.1:${port}/manager_remote_test_parity`};
    const selected=process.argv.slice(3);if(selected.some(name=>!/^[a-z0-9-]+$/.test(name)))throw Error('Invalid isolated test selection');
    const files=(selected.length?selected:['managed-servers','agent-update-api','remote-guided-setup','remote-operations','remote-infrastructure','remote-resources','server-removal','application-removal','remote-app-controls','remote-storage','remote-storage-agent']).map(x=>'tests/'+x+'.test.cjs');
    const code=await new Promise(resolve=>{const child=spawn(process.execPath,['--require','./tests/register.cjs','--test','--test-concurrency=1',...files],{cwd:path.resolve(__dirname,'../..'),env,windowsHide:true,stdio:'inherit'});child.on('error',()=>resolve(1));child.on('exit',resolve)});if(code!==0)throw Error('Remote API integration tests failed');
  }finally{
    if(started)await run('pg_ctl',['-D',data,'-w','-m','fast','stop']);
    if(!path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'manager-parity-db-'))throw Error('Unexpected fixture path');
    await fs.rm(root,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error.message);process.exitCode=1});
