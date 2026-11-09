'use strict';
// Used only by the reviewed privileged installer, never by an application job.
const fs=require('node:fs/promises'),path=require('node:path');
const {loadPostgresRuntime}=require('./agent-runtime-loader.cjs');
async function contained(root,...parts){
  const file=path.resolve(root,...parts),relative=path.relative(root,file);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Invalid installer runtime path');
  let current=root;for(const part of relative.split(path.sep)){current=path.join(current,part);const info=await fs.lstat(current).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(info?.isSymbolicLink())throw Error('Installer runtime contains a link');}return file;
}
async function initialize(file,mode){
  const root=await fs.realpath(path.dirname(file)),p=JSON.parse(await fs.readFile(file,'utf8'));
  if(p.service!=='mongodb'||p.mode!=='install'||!['initialize','verify'].includes(mode)||!/^[a-f0-9-]{36}$/i.test(p.operationId)||!/^[a-f0-9]{72}$/.test(p.databasePassword)||!Number.isInteger(p.port)||p.port<1024||p.port>65535)throw Error('Invalid private database initialization plan');
  const {MongoClient}=await loadPostgresRuntime(root,p.driverArchive,{contained},'mongodb'),url=`mongodb://127.0.0.1:${p.port}/?authSource=admin`,options={serverSelectionTimeoutMS:3000,connectTimeoutMS:3000,socketTimeoutMS:10000},auth={username:'manager_provisioner',password:p.databasePassword};
  let client,last;
  for(let attempt=0;attempt<20;attempt++){
    client=new MongoClient(url,{...options,auth});
    try{await client.connect();await client.db('admin').command({connectionStatus:1});last=null;break;}
    catch(error){last=error;await client.close();if(mode==='initialize'&&[13,18].includes(error.code)){
      const bootstrap=new MongoClient(url,options);try{await bootstrap.connect();await bootstrap.db('admin').command({createUser:auth.username,pwd:auth.password,roles:[{role:'root',db:'admin'}]});}finally{await bootstrap.close();}
    }else if(error.code===18)throw Error('The saved database credential was rejected; existing accounts were not changed');await new Promise(resolve=>setTimeout(resolve,500));}
  }
  if(last)throw Error('The new database did not become ready for authenticated verification');
  try{const markers=client.db('manager_install_check').collection('persistence');if(mode==='initialize')await markers.updateOne({_id:'installation'},{$setOnInsert:{token:p.operationId}},{upsert:true});if((await markers.findOne({_id:'installation'}))?.token!==p.operationId)throw Error('Database persistence receipt does not belong to this installation');}
  finally{await client.close();}
  return{authenticated:true,persistenceVerified:true};
}
module.exports={initialize,contained};
if(require.main===module)initialize(process.argv[2],process.argv[3]).then(()=>console.log('[service] Authenticated database and persistence receipt verified.')).catch(()=>{console.error('Database initialization or verification failed. Existing data and recovery credentials were preserved.');process.exitCode=1;});
