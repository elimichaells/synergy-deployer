'use strict';
// Portable, verified prerequisites. Sling also uses this path on Windows.
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto'),{spawn}=require('node:child_process');
const execute=(file,args)=>new Promise((resolve,reject)=>{const p=spawn(file,args,{stdio:'inherit',windowsHide:true});p.on('error',reject);p.on('close',c=>c===0?resolve():reject(Error('Tool installation failed')))});
async function main(){const [file,target]=process.argv.slice(2),p=JSON.parse(await fs.readFile(file,'utf8'));let executable;const slingFile=process.platform==='win32'?'sling.exe':'sling';if(p.service==='sling'&&await fs.lstat(path.join(target,slingFile)).catch(()=>null))throw Error('The Sling executable already exists. Choose Reuse; it will not be overwritten.');
  if(p.service==='pm2'||p.service==='angular'){
    const version=p.service==='pm2'?p.downloads.pm2Version:p.downloads.angularVersion;if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Invalid npm runtime version');
    if(await fs.lstat(path.join(target,'node_modules')).catch(()=>null))throw Error('The runtime directory already exists. Choose Reuse; it will not be overwritten.');
    const npm=path.join(path.dirname(process.execPath),process.platform==='win32'?'node_modules/npm/bin/npm-cli.js':'../lib/node_modules/npm/bin/npm-cli.js');
    await execute(process.execPath,[npm,'install','--prefix',target,'--omit=dev','--ignore-scripts','--no-audit','--no-fund','--engine-strict',`${p.service==='pm2'?'pm2':'@angular/cli'}@${version}`]);
    executable=path.join(target,p.service==='pm2'?'node_modules/pm2/bin/pm2':process.platform==='win32'?'node_modules/.bin/ng.cmd':'node_modules/.bin/ng');
  }
  else{const asset=p.mode==='install-version'?p.downloads.versionAsset:p.downloads[p.service];if(!asset?.url.startsWith('https://')||!/^[a-f0-9]{64}$/.test(asset.sha256))throw Error('Invalid verified archive');const r=await fetch(asset.url,{redirect:'follow',signal:AbortSignal.timeout(600000)});if(!r.ok)throw Error('Tool download failed');const chunks=[];let size=0;for await(const chunk of r.body){size+=chunk.length;if(size>800*1024*1024)throw Error('Archive exceeds its size limit');chunks.push(chunk)}const bytes=Buffer.concat(chunks);if(createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw Error('Tool checksum mismatch');const archive=path.join(target,'package.tar');await fs.writeFile(archive,bytes);await execute('tar',[(p.mode==='install-version'?asset.format==='tar.xz':p.service==='node')?'-xJf':'-xzf',archive,'-C',target,...(p.mode==='install-version'?[]:p.service==='node'?['--strip-components=1']:[p.service==='sling'?slingFile:'caddy'])]);executable=path.join(target,p.mode==='install-version'?asset.executable:p.service==='node'?'bin/node':p.service==='sling'?slingFile:'caddy');await fs.unlink(archive);}
  if(process.platform!=='win32')await execute('chmod',['-R','a+rX',target]);await fs.writeFile(path.join(target,'executable.txt'),executable);
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1});
