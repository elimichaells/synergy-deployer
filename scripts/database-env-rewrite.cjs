'use strict';
// Shared by Manager and its agent. Replace only settings which identify the
// reviewed database; unrelated databases, comments and other variables survive.
const hostKey=value=>['localhost','::1','[::1]'].includes(String(value).toLowerCase())?'127.0.0.1':String(value).toLowerCase();
function replacements(values,from,to){
  const changed={};
  for(const [key,value] of Object.entries(values)){
    if(typeof value!=='string'||!/^postgres(?:ql)?:\/\//i.test(value))continue;
    try{
      const url=new URL(value);
      if(hostKey(url.hostname)!==hostKey(from.host)||(Number(url.port)||5432)!==from.port||decodeURIComponent(url.pathname.slice(1))!==from.database||from.username&&decodeURIComponent(url.username)!==from.username)continue;
      url.hostname=to.host.includes(':')&&!to.host.startsWith('[')?`[${to.host}]`:to.host;url.port=String(to.port);url.pathname='/'+encodeURIComponent(to.database);url.username=to.username;url.password=to.password;
      if(typeof to.tls==='boolean'&&(hostKey(to.host)!==hostKey(from.host)||to.port!==from.port||to.tls!==from.tls))url.searchParams.set('sslmode',to.tls?'verify-full':'disable');
      changed[key]=url.href;
    }catch{/* Leave non-URL values alone. */}
  }
  const groups=[['DB_HOST','DB_PORT','DB_DATABASE','DB_USERNAME','DB_PASSWORD'],['DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD'],['DATABASE_HOST','DATABASE_PORT','DATABASE_NAME','DATABASE_USER','DATABASE_PASSWORD']];
  for(const key of Object.keys(values))if(key.endsWith('_DATABASE')){const prefix=key.slice(0,-9);groups.push([prefix+'_HOST',prefix+'_PORT',key,prefix+'_USER',prefix+'_PASSWORD']);}
  for(const [host,port,database,user,password] of groups){
    if(values[database]!==from.database||from.username&&values[user]!==from.username||hostKey(values[host]||'127.0.0.1')!==hostKey(from.host)||(Number(values[port])||5432)!==from.port)continue;
    Object.assign(changed,{[host]:to.host,[port]:String(to.port),[database]:to.database,[user]:to.username,[password]:to.password});
  }
  return Object.fromEntries(Object.entries(changed).filter(([key,value])=>values[key]!==value));
}
function parse(content){
  const values={};
  for(const line of content.split(/\r?\n/)){
    const match=/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);if(!match)continue;
    const raw=match[2];let value;
    if(raw.startsWith('"')){const quoted=/^"(?:[^"\\]|\\.)*"/.exec(raw)?.[0];if(!quoted)continue;try{value=JSON.parse(quoted)}catch{value=quoted.slice(1,-1)}}
    else if(raw.startsWith("'")){const end=raw.indexOf("'",1);if(end<0)continue;value=raw.slice(1,end);}
    else value=raw.replace(/\s+#.*$/,'').trim();
    values[match[1]]=value;
  }
  return values;
}
function rewrite(content,from,to){
  const values=parse(content),changes=replacements(values,from,to),seen=new Set(),newline=content.includes('\r\n')?'\r\n':'\n';
  const lines=content.split(/\r?\n/).map(line=>{
    const match=/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/.exec(line);if(!match||!(match[2] in changes))return line;
    seen.add(match[2]);const comment=/^(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^#]*?)(\s+#.*)$/.exec(match[4])?.[1]||'';
    return match[1]+match[2]+match[3]+JSON.stringify(changes[match[2]])+comment;
  });
  for(const [key,value] of Object.entries(changes))if(!seen.has(key))lines.push(key+'='+JSON.stringify(value));
  return {content:lines.join(newline),changed:Object.keys(changes).length,values:{...values,...changes}};
}
module.exports={replacements,rewrite,parse,hostKey};
