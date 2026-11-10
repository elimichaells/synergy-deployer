'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const artifacts=new Set(['node_modules','vendor','.next','.next.backup','dist','.angular','.turbo','app.exe']);
const defaults=['uploads','storage','public/uploads','public/storage','.env.production','.env.production.local'];
const stat=filename=>fs.lstat(filename).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
const inside=(root,filename)=>{const relative=path.relative(root,filename);return !!relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
function retainedPaths(values){
  const candidates=values.filter(Boolean).map(value=>value.replace(/\\/g,'/').replace(/\/$/,''));
  for(const value of candidates)if(path.isAbsolute(value)||value.includes(':')||value.split('/').some(part=>!part||part==='..'||part==='.')||/[\x00-\x1f]/.test(value))throw Error('Invalid persistent application path');
  const key=value=>process.platform==='win32'?value.toLowerCase():value;
  return [...new Map(candidates.map(value=>[key(value),value])).values()]
    .filter(value=>!artifacts.has(key(value).split('/')[0])&&!/^\.(?:git|manager-)/i.test(value)&&!['.env','.env.local'].includes(key(value)))
    .sort((a,b)=>a.length-b.length||a.localeCompare(b)).filter((value,index,all)=>!all.slice(0,index).some(parent=>key(value).startsWith(key(parent)+'/')));
}
async function ordinaryAncestors(root,filename){
  if(!inside(root,filename))throw Error('Persistent data path escaped its release');
  let cursor=path.dirname(filename);
  while(cursor!==root){const info=await stat(cursor);if(info&&(!info.isDirectory()||info.isSymbolicLink()))throw Error('Persistent data ancestor must be an ordinary directory');cursor=path.dirname(cursor);}
  const info=await stat(root);if(!info?.isDirectory()||info.isSymbolicLink())throw Error('Release root must be an ordinary directory');
}
async function plan(previous,candidate,backup,untracked){
  const moves=[];
  const laravel=!!await stat(path.join(previous,'artisan'));
  for(const relative of retainedPaths([...defaults,...untracked])){
    if(laravel&&(relative==='public/build'||relative.startsWith('public/build/')||relative==='bootstrap/cache'||relative.startsWith('bootstrap/cache/')))continue;
    const source=path.join(previous,relative),destination=path.join(candidate,relative),displaced=path.join(backup,relative);
    await ordinaryAncestors(previous,source);await ordinaryAncestors(candidate,destination);
    const info=await stat(source);if(!info)continue;
    if(!info.isDirectory()&&!info.isFile()&&!info.isSymbolicLink())throw Error('Persistent application data must be a regular file, directory or internal link');
    let link=null;
    if(info.isSymbolicLink()){
      const target=await fs.readlink(source),absolute=path.resolve(path.dirname(source),target);
      if(!inside(previous,absolute))throw Error('Persistent link leaves the application release; configure an application-local data path before deployment');
      link={target:path.join(candidate,path.relative(previous,absolute)),type:(await fs.stat(source)).isDirectory()?(process.platform==='win32'?'junction':'dir'):'file'};
    }
    moves.push({relative,source,destination,displaced,link,stage:'planned'});
  }
  return moves;
}
async function activate(moves,persist){
  for(const move of moves){
    await fs.mkdir(path.dirname(move.destination),{recursive:true});
    // Intent is persisted before each rename. Recovery also handles a crash
    // between the filesystem change and its completion record.
    move.stage='displacing';await persist();
    if(await stat(move.destination)){await fs.mkdir(path.dirname(move.displaced),{recursive:true});if(await stat(move.displaced))throw Error('Persistent data backup already exists');await fs.rename(move.destination,move.displaced);}
    move.stage='moving';await persist();
    if(move.link)await fs.symlink(move.link.target,move.destination,move.link.type);
    else await fs.rename(move.source,move.destination);
    move.stage='active';await persist();
  }
}
async function restore(moves,persist){
  for(const move of [...moves].reverse()){
    if(move.stage==='planned'||move.stage==='restored')continue;
    const source=await stat(move.source),destination=await stat(move.destination);
    if(['moving','active','restoring'].includes(move.stage)){
      move.stage='restoring';await persist();
      if(move.link){if(destination){if(!destination.isSymbolicLink())throw Error('Persistent link changed during activation; refusing to replace it');await fs.unlink(move.destination);}}
      else if(!source&&destination){await fs.mkdir(path.dirname(move.source),{recursive:true});await fs.rename(move.destination,move.source);}
      else if(!source&&!destination)throw Error('Persistent data is missing from both releases; recovery needs attention');
      else if(source&&destination)throw Error('Persistent data exists in both releases; refusing to overwrite either copy');
    }
    move.stage='restoring-candidate';await persist();
    if(await stat(move.displaced)){if(await stat(move.destination))throw Error('Candidate data destination is occupied; refusing to overwrite it');await fs.rename(move.displaced,move.destination);}
    move.stage='restored';await persist();
  }
}
module.exports={retainedPaths,plan,activate,restore,inside};
