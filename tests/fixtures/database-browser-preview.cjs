'use strict';
// Private loopback-only compatibility preview. Does not read or change Manager,
// database servers, global PHP configuration, proxy routes or process managers.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http'),cp=require('node:child_process'),{promisify}=require('node:util'),{randomBytes,createHash}=require('node:crypto');
const {createRelay}=require('../../scripts/database-browser-relay.cjs'),{handle}=require('../../scripts/database-browser-agent.cjs');
(async()=>{
  const phpCgi=process.argv[2];if(!phpCgi||!path.isAbsolute(phpCgi))throw Error('Pass an existing absolute PHP CGI path');await fs.access(phpCgi);
  const root=process.argv[3]||await fs.mkdtemp(path.join(os.tmpdir(),'manager-browser-preview-')),asset=require('../../installer/offline/dependencies.lock.json').artifacts.find(item=>item.id==='phpmyadmin');
  if(!process.argv[3]){
  const response=await fetch(asset.url),bytes=Buffer.from(await response.arrayBuffer());if(!response.ok||createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw Error('phpMyAdmin checksum did not match');const archive=path.join(root,'client.zip');await fs.writeFile(archive,bytes);
  const execute=promisify(cp.execFile);if(process.platform==='win32')await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command','Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:PREVIEW_ARCHIVE,$env:PREVIEW_ROOT)'],{windowsHide:true,env:{...process.env,PREVIEW_ARCHIVE:archive,PREVIEW_ROOT:root}});else await execute('unzip',['-q',archive,'-d',root]);
  }
  const clientRoot=path.join(root,asset.root),tempRoot=path.join(root,'temp'),sessionRoot=path.join(root,'sessions'),phpIni=path.join(root,'php.ini');for(const directory of [tempRoot,sessionRoot,path.join(clientRoot,'.ini-scan')])await fs.mkdir(directory,{recursive:true});
  const slash=value=>value.replaceAll('\\','/');
  await fs.writeFile(phpIni,`extension_dir="${slash(path.join(path.dirname(phpCgi),'ext'))}"\nextension=mysqli\nextension=mbstring\nextension=openssl\nextension=curl\nallow_url_fopen=0\nexpose_php=0\ndisplay_errors=0\nlog_errors=0\ncgi.force_redirect=1\ncgi.fix_pathinfo=0\nzlib.output_compression=0\nsession.save_path="${slash(sessionRoot)}"\nupload_tmp_dir="${slash(tempRoot)}"\npost_max_size=8M\nupload_max_filesize=8M\n`);
  await fs.writeFile(path.join(clientRoot,'config.inc.php'),`<?php\n$cfg['blowfish_secret']=hex2bin(getenv('PHPMYADMIN_BLOWFISH_SECRET'));\n$cfg['PmaAbsoluteUri']=getenv('PHPMYADMIN_PUBLIC_URL');\n$cfg['TempDir']=getenv('PHPMYADMIN_TEMP_DIR');\n$cfg['SessionSavePath']=getenv('PHPMYADMIN_SESSION_DIR');\n$cfg['VersionCheck']=false;\n$cfg['SendErrorReports']='never';\n$cfg['Servers'][1]['auth_type']='cookie';\n$cfg['Servers'][1]['host']=getenv('PHPMYADMIN_DB_HOST');\n$cfg['Servers'][1]['port']=getenv('PHPMYADMIN_DB_PORT');\n$cfg['Servers'][1]['AllowNoPassword']=false;\n$cfg['AllowArbitraryServer']=false;\n`);
  await fs.appendFile(path.join(clientRoot,'config.inc.php'),"$cfg['AllowThirdPartyFraming']=true;\n");
  await fs.writeFile(path.join(root,'database-browser.json'),JSON.stringify({clientRoot,tempRoot,sessionRoot,phpCgi,phpIni,secret:randomBytes(32).toString('hex')}),{mode:0o600});
  let databasePort=1;
  if(process.argv[4]==='reuse-fixture'){
    const receipt=JSON.parse(await fs.readFile(path.join(root,'isolated-mysql-process.json'),'utf8'));if(receipt.data!==path.join(root,'isolated-mysql-data')||receipt.port===3306)throw Error('Invalid private MySQL receipt');databasePort=receipt.port;
  }else if(process.argv[4]){
    const executable=process.argv[4];if(!path.isAbsolute(executable)||!['mysqld.exe','mysqld'].includes(path.basename(executable)))throw Error('Pass the existing MySQL server binary');
    const data=path.join(root,'isolated-mysql-data');await fs.mkdir(data);const execute=promisify(cp.execFile);
    await execute(executable,['--no-defaults','--initialize-insecure','--datadir='+data],{windowsHide:true,timeout:120000});
    const net=require('node:net'),probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));databasePort=probe.address().port;await new Promise(resolve=>probe.close(resolve));if(databasePort===3306)throw Error('Refuse default database port');
    const bootstrap=path.join(root,'isolated-mysql-bootstrap.sql');await fs.writeFile(bootstrap,"ALTER USER 'root'@'localhost' IDENTIFIED BY '"+randomBytes(32).toString('hex')+"';\nCREATE DATABASE fixture;\nCREATE USER 'fixture'@'127.0.0.1' IDENTIFIED BY 'Disposable_preview_only_42!';\nGRANT ALL ON fixture.* TO 'fixture'@'127.0.0.1';\nCREATE TABLE fixture.preserved(id INT PRIMARY KEY, value VARCHAR(40));\nINSERT INTO fixture.preserved VALUES (1,'preserved fixture record');\n",{mode:0o600});
    const database=cp.spawn(executable,['--no-defaults','--datadir='+data,'--bind-address=127.0.0.1','--port='+databasePort,'--mysqlx=0','--skip-log-bin','--init-file='+bootstrap],{windowsHide:true,stdio:'ignore'});
    process.on('exit',()=>database.kill());process.on('SIGINT',()=>process.exit(0));process.on('SIGTERM',()=>process.exit(0));
    const mysql=require('mysql2/promise');let ready=false;for(let attempt=0;attempt<100;attempt++){try{const connection=await mysql.createConnection({host:'127.0.0.1',port:databasePort,user:'fixture',password:'Disposable_preview_only_42!',database:'fixture'});await connection.end();ready=true;break}catch{await new Promise(resolve=>setTimeout(resolve,200));}}if(!ready)throw Error('Private MySQL did not start');await fs.unlink(bootstrap);
    await fs.writeFile(path.join(root,'isolated-mysql-process.json'),JSON.stringify({pid:database.pid,data,port:databasePort}));
  }
  const relay=createRelay({pollMs:50});let origin,lease;
  const server=http.createServer(async(req,res)=>{try{
    const url=new URL(req.url,origin);if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Isolated database browser preview</title><h1>Isolated phpMyAdmin compatibility test</h1><iframe style="width:100%;height:85vh;border:1px solid #888" src="'+lease.url+'"></iframe>');return;}
    const match=url.pathname.match(/^\/api\/database-browser\/([A-Za-z0-9_-]{43})\/(.*)$/);if(!match){res.writeHead(404);res.end();return;}
    const headers=relay.headers(match[1]);if(req.method==='OPTIONS'){res.writeHead(204,headers);res.end();return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const pending=relay.enqueue(match[1],{method:req.method,path:match[2]+url.search,body:Buffer.concat(chunks),contentType:req.headers['content-type'],accept:req.headers.accept,requestedWith:req.headers['x-requested-with']});
    const result=await pending;res.writeHead(result.status,result.headers);res.end(result.body);
  }catch(error){console.error('Preview HTTP error:',error.status||500,error.message);res.writeHead(error.status||500,{'Content-Type':'text/plain'});res.end(error.message);}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;lease=relay.open('preview',{id:'preview',provider:'mysql',host:'127.0.0.1',port:databasePort},origin,'fixture-admin');
  for(let n=0;n<4;n++)void(async()=>{while(true){const {request}=await relay.claim('preview');if(!request)continue;try{const result=await handle(root,origin,request);if(result.status>=400)console.error('Preview CGI response:',result.status,new URL(request.publicBase+request.path).searchParams.get('route'));relay.report('preview',{...result,id:request.id,claimToken:request.claimToken})}catch(error){console.error('Preview CGI failure:',error.message);relay.report('preview',{id:request.id,claimToken:request.claimToken,error:true})}}})();
  console.log(JSON.stringify({url:origin,root}));
})().catch(error=>{console.error(error.message);process.exitCode=1});
