'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {gunzipSync}=require('node:zlib');
const {createRequire}=require('node:module');
async function loadPostgresRuntime(root,archive,h,driver='pg'){
  if(!['pg','mysql2/promise','mssql','mongodb','redis'].includes(driver)||typeof archive!=='string'||archive.length>8000000)throw Error('Invalid database driver');
  const encoded=Buffer.from(archive,'base64'),hash=createHash('sha256').update(encoded).digest('hex');
  const runtime=await h.contained(root,'database-runtime',hash);await fs.mkdir(runtime,{recursive:true,mode:0o700});
  const files=JSON.parse(gunzipSync(encoded,{maxOutputLength:32*1024*1024}).toString());
  for(const [relative,source] of Object.entries(files)){
    if(!relative.startsWith('node_modules/')||relative.includes('\\')||relative.split('/').some(part=>!part||part==='.'||part==='..'||part.includes(':'))||typeof source!=='string')throw Error('Invalid bundled database driver path');
    const filename=await h.contained(root,path.relative(root,path.join(runtime,relative)));await fs.mkdir(path.dirname(filename),{recursive:true,mode:0o700});
    try{await fs.writeFile(filename,source,{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;if(await fs.readFile(filename,'utf8')!==source)throw Error('Database driver cache changed; repair the agent installation');}
  }
  return createRequire(path.join(runtime,'entry.cjs'))(driver);
}
module.exports={loadPostgresRuntime};
