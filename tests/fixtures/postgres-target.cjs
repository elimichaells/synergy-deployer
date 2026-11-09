'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net'),{execFile}=require('node:child_process'),{promisify}=require('node:util'),{randomBytes}=require('node:crypto');
module.exports=async function target(t){
  const bin=process.env.MANAGER_REMOTE_TEST_PG_BIN;if(!bin||!path.isAbsolute(bin))throw Error('A private PostgreSQL test binary directory is required');
  const temp=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(temp,'manager-move-target-')),data=path.join(root,'data'),password=randomBytes(24).toString('hex'),run=(name,args)=>promisify(execFile)(path.join(bin,name+(process.platform==='win32'?'.exe':'')),args,{windowsHide:true,timeout:30000});let started=false;
  t.after(async()=>{if(started)await run('pg_ctl',['-D',data,'-w','-m','fast','stop']);if(path.dirname(root)!==temp||!path.basename(root).startsWith('manager-move-target-'))throw Error('Unexpected private PostgreSQL directory');await fs.rm(root,{recursive:true,force:true});});
  const file=path.join(root,'password');await fs.writeFile(file,password,{mode:0o600});await run('initdb',['-D',data,'-U','move_target_admin','-A','scram-sha-256','--encoding=UTF8','--pwfile='+file]);await fs.unlink(file);
  const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});await fs.appendFile(path.join(data,'postgresql.conf'),`\nlisten_addresses='127.0.0.1'\nport=${port}\n`);await run('pg_ctl',['-D',data,'-l',path.join(root,'postgres.log'),'-w','start']);started=true;
  return{provider:'postgresql',host:'127.0.0.1',port,username:'move_target_admin',password,database:'postgres',tls:false};
};
