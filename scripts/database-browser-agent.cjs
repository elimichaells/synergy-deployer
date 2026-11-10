'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process'),{createHash,X509Certificate}=require('node:crypto');
const LIMIT=8*1024*1024;
const mime={'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.svg':'image/svg+xml','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.eot':'application/vnd.ms-fontobject','.txt':'text/plain; charset=utf-8','.map':'application/json'};

function cgi(config,env,body,signal){return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(Error('Browser request cancelled'));return;}
  const child=spawn(config.phpCgi,['-c',config.phpIni],{env,cwd:config.clientRoot,windowsHide:true,stdio:['pipe','pipe','pipe']}),chunks=[];let size=0,failed=false;
  const stop=()=>{failed=true;child.kill();},timer=setTimeout(stop,30000);signal?.addEventListener('abort',stop,{once:true});
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>LIMIT+64000)stop();else chunks.push(chunk)});child.stderr.resume();child.stdin.on('error',()=>{});
  child.on('error',()=>{failed=true;});child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);if(failed||code!==0){reject(Error('Database browser request failed'));return;}resolve(Buffer.concat(chunks));});child.stdin.end(body);
});}

function response(bytes){
  let offset=bytes.indexOf('\r\n\r\n'),separator=4;if(offset<0){offset=bytes.indexOf('\n\n');separator=2;}
  if(offset<0||offset>64000||bytes.length-offset-separator>LIMIT)throw Error('Invalid database browser response');
  let status=200;const headers=[];
  for(const line of bytes.subarray(0,offset).toString('utf8').split(/\r?\n/)){const at=line.indexOf(':');if(at<1)throw Error('Invalid CGI header');const name=line.slice(0,at).trim(),value=line.slice(at+1).trim();if(name.toLowerCase()==='status')status=Number(value.slice(0,3));else headers.push([name,value]);}
  return{status,headers,body:bytes.subarray(offset+separator).toString('base64')};
}

async function handle(root,manager,input,signal,execute=cgi){
  const config=JSON.parse(await fs.readFile(path.join(root,'database-browser.json'),'utf8'));
  if(!config||!/^[a-f0-9]{64}$/.test(config.secret)||![config.clientRoot,config.phpCgi,config.phpIni,config.tempRoot,config.sessionRoot].every(value=>typeof value==='string'&&path.isAbsolute(value)))throw Error('Invalid database browser installation');
  const base=new URL(input.publicBase),managerUrl=new URL(manager);
  if(base.origin!==managerUrl.origin||!/^\/api\/database-browser\/[A-Za-z0-9_-]{43}\/$/.test(base.pathname)||base.search||base.hash||base.username||base.password)throw Error('Database browser address does not match Manager');
  if(!['GET','HEAD','POST'].includes(input.method)||typeof input.path!=='string'||input.path.length>4096||typeof input.body!=='string'||input.body.length>Math.ceil(LIMIT/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.body))throw Error('Invalid database browser request');
  const at=input.path.indexOf('?'),raw=at<0?input.path:input.path.slice(0,at),query=at<0?'':input.path.slice(at+1),name=decodeURIComponent(raw||'index.php');
  if(/[\\\x00-\x1f:]/.test(name)||name.startsWith('/')||name.split('/').some(part=>part.startsWith('.')||!part))throw Error('Invalid database browser path');
  const clientRoot=await fs.realpath(config.clientRoot),filename=await fs.realpath(path.join(clientRoot,name)),relative=path.relative(clientRoot,filename);
  if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Database browser file is outside its installation');
  const stat=await fs.stat(filename);if(!stat.isFile()||stat.size>LIMIT)throw Error('Database browser file is unavailable');
  if(!name.endsWith('.php')){const type=mime[path.extname(name).toLowerCase()];if(!type||input.method==='POST')throw Error('Unsupported database browser file');return{status:200,headers:[['Content-Type',type]],body:input.method==='HEAD'?'':(await fs.readFile(filename)).toString('base64')};}
  if(!['index.php','js/messages.php'].includes(name))throw Error('This phpMyAdmin entry point is not exposed');
  const connection=input.connection;
  if(!connection||typeof connection.host!=='string'||/[\s/\\\0]/.test(connection.host)||!Number.isInteger(connection.port)||connection.port<1||connection.port>65535)throw Error('Invalid database browser connection');
  let caFile='';
  if(connection.caPem){if(typeof connection.caPem!=='string'||connection.caPem.length>16384||connection.caPem.includes('PRIVATE KEY'))throw Error('Invalid database CA');const cert=new X509Certificate(connection.caPem);if(!cert.ca)throw Error('Invalid database CA');const folder=path.join(config.tempRoot,'certificates');await fs.mkdir(folder,{recursive:true,mode:0o700});caFile=path.join(folder,createHash('sha256').update(cert.toString()).digest('hex')+'.pem');try{await fs.writeFile(caFile,cert.toString(),{mode:0o600,flag:'wx'})}catch(error){if(error.code!=='EEXIST')throw error;if((await fs.lstat(caFile)).isSymbolicLink()||await fs.readFile(caFile,'utf8')!==cert.toString())throw Error('Database CA file changed');}}
  const body=Buffer.from(input.body,'base64');if(body.length>LIMIT)throw Error('Database browser upload is too large');
  const safe=value=>typeof value==='string'&&!/[\x00-\x1f]/.test(value)?value:'';
  const env={SystemRoot:process.env.SystemRoot||'',WINDIR:process.env.WINDIR||'',Path:process.env.Path||process.env.PATH||'',PATH:process.env.PATH||process.env.Path||'',TEMP:config.tempRoot,TMP:config.tempRoot,
    PHP_INI_SCAN_DIR:path.join(config.clientRoot,'.ini-scan'),PHPMYADMIN_BLOWFISH_SECRET:config.secret,PHPMYADMIN_PUBLIC_URL:base.href,PHPMYADMIN_DB_HOST:connection.host,PHPMYADMIN_DB_PORT:String(connection.port),PHPMYADMIN_DB_TLS:connection.tls?'1':'0',PHPMYADMIN_DB_CA:caFile,PHPMYADMIN_TEMP_DIR:config.tempRoot,PHPMYADMIN_SESSION_DIR:config.sessionRoot,
    GATEWAY_INTERFACE:'CGI/1.1',REDIRECT_STATUS:'200',SERVER_PROTOCOL:'HTTP/1.1',SERVER_NAME:base.hostname,SERVER_PORT:base.port||(base.protocol==='https:'?'443':'80'),HTTP_HOST:base.host,HTTPS:base.protocol==='https:'?'on':'off',REMOTE_ADDR:'127.0.0.1',
    REQUEST_METHOD:input.method,QUERY_STRING:query,SCRIPT_FILENAME:filename,SCRIPT_NAME:base.pathname+name,DOCUMENT_ROOT:clientRoot,REQUEST_URI:base.pathname+input.path,
    CONTENT_TYPE:safe(input.contentType),CONTENT_LENGTH:String(body.length),HTTP_COOKIE:safe(input.cookie),HTTP_ACCEPT:safe(input.accept),HTTP_X_REQUESTED_WITH:input.requestedWith==='XMLHttpRequest'?'XMLHttpRequest':'',HTTP_ORIGIN:base.origin,HTTP_REFERER:base.href};
  return response(await execute(config,env,body,signal));
}
async function version(root){try{const config=JSON.parse(await fs.readFile(path.join(root,'database-browser.json'),'utf8'));if(!/^\d+\.\d+\.\d+$/.test(config.version))return null;for(const file of [config.phpCgi,config.phpIni,path.join(config.clientRoot,'index.php')])if(!(await fs.stat(file)).isFile())return null;return config.version;}catch{return null}}
function start(root,config,request){
  const controller=new AbortController();let active=0;
  const pause=()=>new Promise(resolve=>{if(controller.signal.aborted){resolve();return;}const done=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,5000);controller.signal.addEventListener('abort',done,{once:true});});
  const workers=Array.from({length:4},async()=>{while(!controller.signal.aborted){try{
    if(!await version(root)){await pause();continue;}
    const {request:job}=await request(config,'browser-claim',{});if(controller.signal.aborted)break;if(!job)continue;
    active++;try{let result;try{result=await handle(root,config.manager,job,controller.signal)}catch{result={error:true}}await request(config,'browser-report',{id:job.id,claimToken:job.claimToken,...result});}finally{active--;}
  }catch{await pause();}}});
  return{get active(){return active;},async stop(){controller.abort();await Promise.allSettled(workers)}};
}
module.exports={handle,cgi,response,version,start};
if(require.main===module)handle(process.argv[2],'https://manager.invalid',{publicBase:'https://manager.invalid/api/database-browser/'+'a'.repeat(43)+'/',method:'GET',path:'index.php',body:'',connection:{host:'127.0.0.1',port:1}}).then(result=>{
  const html=Buffer.from(result.body,'base64').toString();
  if(result.status!==200||!html.includes('name="pma_username"')){
    // This unauthenticated installation probe has no real database credentials.
    // Rendered error text helps diagnose missing extensions and session access;
    // scripts and form values (including fresh CSRF tokens) never enter logs.
    const detail=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().slice(0,700);
    throw Error(`Database browser login page failed its check (HTTP ${result.status}): ${detail}`);
  }
}).catch(error=>{console.error(error.message);process.exitCode=1});
