const fs=require('node:fs');
const path=require('node:path');
const cp=require('node:child_process');
const {sha}=require('./manager-update-package.cjs');
async function build(root,out) {
  root=path.resolve(root);out=path.resolve(out);
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json')));
  fs.mkdirSync(out,{recursive:true});
  const runtime=fs.mkdtempSync(path.join(path.dirname(out),'bootstrap-build-'));
  fs.mkdirSync(path.join(runtime,'scripts'),{recursive:true});
  fs.writeFileSync(path.join(runtime,'package.json'),JSON.stringify({private:true,version:pkg.version}));
  for(const name of ['bootstrap-manager-upgrade.cjs','install-manager-updater.ps1','register-manager-updater.cjs','manager-update-worker.cjs','manager-update-state.cjs','manager-update-package.cjs','update-trusted-root.json'])fs.copyFileSync(path.join(root,'scripts',name),path.join(runtime,'scripts',name));
  // Resolve from each original parent, then flatten identical versions to stay
  // within Windows PowerShell's path limit. Fail closed on version conflicts.
  const copied=new Map();
  function dependency(name,from) {
    let manifest;
    try{manifest=require.resolve(name+'/package.json',{paths:[from]})}catch(e){
      if(e.code!=='ERR_PACKAGE_PATH_NOT_EXPORTED')throw e;
      let dir=path.dirname(require.resolve(name,{paths:[from]}));
      while(dir!==path.dirname(dir)){const file=path.join(dir,'package.json');if(fs.existsSync(file)&&JSON.parse(fs.readFileSync(file)).name===name){manifest=file;break}dir=path.dirname(dir)}
      if(!manifest)throw new Error('Cannot find '+name);
    }
    const source=path.dirname(manifest),p=JSON.parse(fs.readFileSync(manifest));
    if(copied.has(name)){if(copied.get(name)!==p.version)throw new Error('Bootstrap dependency version conflict: '+name);return;}
    copied.set(name,p.version);
    fs.cpSync(source,path.join(runtime,'node_modules',name),{recursive:true,filter:file=>path.relative(source,file).split(path.sep)[0]!=='node_modules'});
    for(const child of Object.keys(p.dependencies||{}))dependency(child,source);
  }
  for(const name of ['pg','dotenv','tar','@sigstore/bundle','@sigstore/protobuf-specs','@sigstore/verify'])dependency(name,root);
  const zip=path.join(out,'manager-bootstrap-runtime.zip');
  const script="$ErrorActionPreference='Stop'; Compress-Archive -Path (Join-Path $env:MANAGER_BOOTSTRAP_SOURCE '*') -DestinationPath $env:MANAGER_BOOTSTRAP_ZIP -CompressionLevel Optimal";
  cp.execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,MANAGER_BOOTSTRAP_SOURCE:runtime,MANAGER_BOOTSTRAP_ZIP:zip},stdio:'inherit',windowsHide:true});
  const template=fs.readFileSync(path.join(root,'scripts/bootstrap-manager-upgrade.ps1'),'utf8');
  fs.writeFileSync(path.join(out,'bootstrap-manager-upgrade.ps1'),template.replaceAll('@@VERSION@@',pkg.version).replaceAll('@@BOOTSTRAP_SHA256@@',await sha(zip)));
  fs.copyFileSync(path.join(root,'docs/releases',pkg.version+'.md'),path.join(out,'RELEASE-NOTES.md'));
  console.log('Built hash-pinned bootstrap runtime and upgrade script.');
}
if(require.main===module)build(...process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={build};
