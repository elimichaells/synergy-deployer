'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
(async()=>{
  if(process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||!['win32','linux'].includes(process.platform))throw Error('This fixture is only for disposable GitHub-hosted runners');
  const parent=path.resolve(process.env.RUNNER_TEMP),root=path.join(parent,'manager-live-tools'),windows=process.platform==='win32',version='2.11.7',name=`caddy_${version}_${windows?'windows':'linux'}_amd64.${windows?'zip':'tar.gz'}`,base=`https://github.com/caddyserver/caddy/releases/download/v${version}/`;
  await fs.mkdir(root,{recursive:true});
  const download=async name=>{const response=await fetch(base+name);if(!response.ok)throw Error('Official Caddy download failed: '+response.status);return Buffer.from(await response.arrayBuffer());};
  const checksums=(await download(`caddy_${version}_checksums.txt`)).toString('utf8'),line=checksums.split(/\r?\n/).find(line=>line.trim().endsWith(name)),expected=line?.trim().split(/\s+/)[0];if(!/^[a-f0-9]{64}$/i.test(expected||''))throw Error('Caddy checksum missing');
  const bytes=await download(name);if(createHash('sha256').update(bytes).digest('hex')!==expected.toLowerCase())throw Error('Caddy checksum mismatch');const archive=path.join(root,name);await fs.writeFile(archive,bytes);
  const run=promisify(execFile);
  if(windows)await run('powershell.exe',['-NoProfile','-NonInteractive','-Command','Expand-Archive -LiteralPath $env:FIXTURE_ARCHIVE -DestinationPath $env:FIXTURE_DESTINATION -Force'],{windowsHide:true,env:{...process.env,FIXTURE_ARCHIVE:archive,FIXTURE_DESTINATION:root}});
  else await run('tar',['-xzf',archive,'-C',root]);
  await fs.appendFile(process.env.GITHUB_ENV,`TEST_CADDY=${path.join(root,windows?'caddy.exe':'caddy')}\nTEST_PM2_PACKAGE_ROOT=${path.join(root,'node_modules','pm2')}\n`);
})().catch(error=>{console.error(error.message);process.exitCode=1});
