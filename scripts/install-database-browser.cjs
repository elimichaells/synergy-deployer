'use strict';
// An optional private CGI client. No listener, proxy configuration, database
// initialization, process manager or global php.ini is changed by this installer.
const fs=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process'),{randomBytes,createHash}=require('node:crypto');
const execute=(file,args,env=process.env)=>new Promise((resolve,reject)=>{const child=spawn(file,args,{windowsHide:true,env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',chunk=>{if(output.length<100000)output+=chunk});child.stderr.resume();child.on('error',reject);child.on('close',code=>code===0?resolve(output):reject(Error('Database browser prerequisite check failed')))});
const slash=value=>value.replaceAll('\\','/');
async function configure(target,phpCgi,version){
  const clientRoot=path.join(target,'client'),tempRoot=path.join(target,'temp'),sessionRoot=path.join(target,'sessions'),phpIni=path.join(target,'php.ini');
  for(const folder of [tempRoot,sessionRoot,path.join(clientRoot,'.ini-scan')])await fs.mkdir(folder,{recursive:true,mode:0o700});
  // Use PHP's compiled extension directory on Linux; do not load the system INI.
  const info=await execute(phpCgi,['-n','-i'],{...process.env,PHP_INI_SCAN_DIR:path.join(clientRoot,'.ini-scan')});
  const extensionDir=process.platform==='win32'?path.join(path.dirname(phpCgi),'ext'):(info.match(/^extension_dir => (\S+)/m)?.[1]||info.match(/extension_dir\s*<\/td>\s*<td[^>]*>\s*([^<\s]+)/)?.[1]);
  if(!extensionDir||/["\r\n]/.test(extensionDir))throw Error('Could not inspect the PHP extension directory');
  const modules=['mysqli','mbstring','openssl','curl','zip','zlib','iconv','ctype','xml','dom','simplexml','xmlreader','xmlwriter','tokenizer','session','fileinfo','sodium'];
  const available=process.platform==='win32'?modules.filter(name=>!['zlib','iconv','ctype','xml','dom','simplexml','xmlreader','xmlwriter','tokenizer','session'].includes(name)):['mysqlnd',...modules];
  const extensions=[];for(const name of available)if(await fs.stat(path.join(extensionDir,process.platform==='win32'?'php_'+name+'.dll':name+'.so')).then(s=>s.isFile()).catch(()=>false))extensions.push('extension='+name);
  await fs.writeFile(phpIni,`extension_dir="${slash(extensionDir)}"\n${extensions.join('\n')}\nallow_url_fopen=0\nexpose_php=0\ndisplay_errors=0\nlog_errors=0\ncgi.force_redirect=1\ncgi.fix_pathinfo=0\nzlib.output_compression=0\nsession.save_path="${slash(sessionRoot)}"\nupload_tmp_dir="${slash(tempRoot)}"\npost_max_size=8M\nupload_max_filesize=8M\nmemory_limit=128M\nmax_execution_time=25\n`,{mode:0o600});
  const loaded=await execute(phpCgi,['-c',phpIni,'-m'],{...process.env,PHP_INI_SCAN_DIR:path.join(clientRoot,'.ini-scan')});for(const name of ['mysqli','mbstring','openssl','session','ctype','json'])if(!loaded.split(/\r?\n/).includes(name))throw Error('PHP is missing the '+name+' extension');
  const phpVersion=await execute(phpCgi,['-n','-v']);if(!/^PHP 8\.[1-3]\./.test(phpVersion))throw Error('Use a supported PHP CGI 8.1–8.3 installation for this client');
  await fs.writeFile(path.join(clientRoot,'config.inc.php'),`<?php
$cfg['blowfish_secret']=hex2bin(getenv('PHPMYADMIN_BLOWFISH_SECRET'));
$cfg['PmaAbsoluteUri']=getenv('PHPMYADMIN_PUBLIC_URL');
$cfg['TempDir']=getenv('PHPMYADMIN_TEMP_DIR');
$cfg['SessionSavePath']=getenv('PHPMYADMIN_SESSION_DIR');
$cfg['VersionCheck']=false;
$cfg['SendErrorReports']='never';
$cfg['AllowThirdPartyFraming']=true;
$cfg['LoginCookieValidity']=1800;
$cfg['Servers'][1]['auth_type']='cookie';
$cfg['Servers'][1]['host']=getenv('PHPMYADMIN_DB_HOST');
$cfg['Servers'][1]['port']=getenv('PHPMYADMIN_DB_PORT');
$cfg['Servers'][1]['AllowNoPassword']=false;
$cfg['Servers'][1]['ssl']=getenv('PHPMYADMIN_DB_TLS')==='1';
$cfg['Servers'][1]['ssl_verify']=true;
if(getenv('PHPMYADMIN_DB_CA')) $cfg['Servers'][1]['ssl_ca']=getenv('PHPMYADMIN_DB_CA');
$cfg['AllowArbitraryServer']=false;
`,{mode:0o600});
  return {clientRoot,tempRoot,sessionRoot,phpCgi,phpIni,version,secret:randomBytes(32).toString('hex')};
}
async function archive(asset,target){
  if(!asset||!/^https:\/\//.test(asset.url)||!/^[a-f0-9]{64}$/.test(asset.sha256))throw Error('Invalid verified database browser asset');
  const response=await fetch(asset.url,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw Error('Database browser download failed');let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>100*1024*1024)throw Error('Browser archive is too large');chunks.push(chunk)}const bytes=Buffer.concat(chunks);if(createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw Error('Database browser checksum mismatch');const file=path.join(target,'package.zip');await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});
  const destination=path.join(target,'unpacked');await fs.mkdir(destination);
  if(process.platform==='win32')await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command','Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:BROWSER_ARCHIVE,$env:BROWSER_DESTINATION)'],{...process.env,BROWSER_ARCHIVE:file,BROWSER_DESTINATION:destination});else await execute('unzip',['-q',file,'-d',destination]);
  await fs.unlink(file);return destination;
}
async function install(plan,target,linuxPhp){
  const marker=path.join(plan.agentRoot,'database-browser.json');if(await fs.lstat(marker).catch(()=>null))throw Error('The private database browser is already configured. It will not be overwritten.');
  const asset=plan.downloads.phpmyadmin;if(!/^\d+\.\d+\.\d+$/.test(asset?.version)||asset.root!=='phpMyAdmin-'+asset.version+'-all-languages')throw Error('Invalid browser release');
  const unpacked=await archive(asset,target);await fs.rename(path.join(unpacked,asset.root),path.join(target,'client'));await fs.rmdir(unpacked);
  let phpCgi=linuxPhp;
  if(process.platform==='win32'){const phpRoot=path.join(target,'php');await fs.mkdir(phpRoot);const unpackedPhp=await archive(plan.downloads.php,phpRoot);phpCgi=path.join(unpackedPhp,'php-cgi.exe');}
  if(!phpCgi||!path.isAbsolute(phpCgi))throw Error('PHP CGI is required');
  const config=await configure(target,phpCgi,asset.version);await fs.writeFile(path.join(target,'database-browser.json'),JSON.stringify(config),{flag:'wx',mode:0o600});
  return config;
}
if(require.main===module)(async()=>{const [file,target,php]=process.argv.slice(2);await install(JSON.parse(await fs.readFile(file,'utf8')),target,php);console.log('[service] Private phpMyAdmin files and PHP extensions verified.');})().catch(error=>{console.error(error.message);process.exitCode=1});
module.exports={configure,install};
