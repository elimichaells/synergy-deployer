'use strict';
// Ship the same locked PostgreSQL driver as Manager. Connected servers do not
// need npm access, a global module installation or an exposed database port.
const fs=require('node:fs/promises');
const path=require('node:path');
const {createRequire}=require('node:module');
const {gzipSync}=require('node:zlib');
const cached=new Map();
async function packagePostgresRuntime(root=process.cwd(),packages=['pg']){
  const key=path.resolve(root)+'|'+packages.join(',');if(cached.has(key))return cached.get(key);
  const pending=(async()=>{
    const modules=await fs.realpath(path.join(root,'node_modules')),files={},seen=new Set();
    const visit=async directory=>{
      directory=await fs.realpath(directory);if(seen.has(directory))return;seen.add(directory);
      const relative=path.relative(modules,directory);if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Database driver escaped the installed dependencies');
      const pkg=JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8'));
      const collect=async folder=>{
        for(const entry of (await fs.readdir(folder,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
          if(entry.name==='node_modules'||['test','tests','benchmark','bench','examples','.github'].includes(entry.name))continue;
          const filename=path.join(folder,entry.name);if(entry.isSymbolicLink())throw Error('Database runtime packages must not contain linked files');
          if(entry.isDirectory())await collect(filename);
          else if(/\.(?:js|cjs|mjs|json)$/.test(entry.name)||/^license(?:\.|$)/i.test(entry.name))files['node_modules/'+path.relative(modules,filename).replace(/\\/g,'/')]=await fs.readFile(filename,'utf8');
        }
      };
      await collect(directory);
      const resolve=createRequire(path.join(directory,'package.json'));
      for(const dependency of Object.keys(pkg.dependencies||{})){
        let resolved;
        if(require('node:module').isBuiltin(dependency)){try{resolved=resolve.resolve(dependency+'/package.json');}catch{continue;}}
        else try{resolved=resolve.resolve(dependency);}catch{resolved=resolve.resolve(dependency+'/package.json');}
        let current=path.dirname(resolved);
        const suffix=path.sep+path.join('node_modules',...dependency.split('/'));
        while(path.dirname(current)!==current){try{const info=JSON.parse(await fs.readFile(path.join(current,'package.json'),'utf8'));if(current.endsWith(suffix)&&info.name===dependency)break;}catch{}current=path.dirname(current);}
        await visit(current);
      }
    };
    for(const name of packages){if(!['pg','mysql2','mssql','mongodb','redis'].includes(name))throw Error('Unreviewed database driver');await visit(path.join(modules,name));}
    const json=JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b))));
    if(Buffer.byteLength(json)>32*1024*1024)throw Error('Database runtime exceeds the reviewed size limit');
    return gzipSync(json,{level:9}).toString('base64');
  })().catch(error=>{cached.delete(key);throw error;});
  cached.set(key,pending);return pending;
}
module.exports={packagePostgresRuntime};
