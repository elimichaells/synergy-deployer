'use strict';
const {randomBytes,timingSafeEqual}=require('node:crypto');
const LIMIT=8*1024*1024, SESSION_MS=30*60*1000;
const sandboxScript=require('./database-browser-sandbox.cjs');
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));

/** A short-lived, single-database browser session. No Manager cookies or saved
 * database passwords enter this transport. Cookie authentication stays in this
 * private cookie jar, so the web client can run in an opaque-origin sandbox. */
function createRelay({now=Date.now,timeoutMs=45000,pollMs=12000}={}){
  const sessions=new Map(),requests=new Map(),waiters=new Map();
  function finish(id,error,response){const item=requests.get(id);if(!item)return;requests.delete(id);clearTimeout(item.timer);item.signal?.removeEventListener('abort',item.abort);error?item.reject(error):item.resolve(response);}
  function sweep(){for(const [token,session]of sessions)if(session.expiresAt<=now()){sessions.delete(token);clearTimeout(session.timer);for(const [id,item]of requests)if(item.session===session)finish(id,fail('Database browser session expired. Reopen it from Storage.',410));}}
  function session(token){sweep();const value=sessions.get(token);if(!value)throw fail('Database browser session expired. Reopen it from Storage.',410);return value;}
  function open(serverId,connection,origin,userId){
    sweep();const url=new URL(origin);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw fail('Invalid Manager address');
    if(!serverId||!connection?.id||!['mysql','mariadb'].includes(connection.provider)||typeof connection.host!=='string'||/[\s/\\\0]/.test(connection.host)||!Number.isInteger(connection.port)||connection.port<1||connection.port>65535)throw fail('Select a MySQL or MariaDB connection');
    if(sessions.size>=100||[...sessions.values()].filter(s=>s.serverId===serverId).length>=10)throw fail('Close an existing database browser session or wait for it to expire.',429);
    const token=randomBytes(32).toString('base64url'),base=url.origin+'/api/database-browser/'+token+'/';
    const timer=setTimeout(()=>close(token),SESSION_MS);timer.unref?.();
    sessions.set(token,{serverId,userId,connection:{id:connection.id,host:connection.host,port:connection.port,tls:connection.tls===true,caPem:connection.caPem||''},base,expiresAt:now()+SESSION_MS,cookies:new Map(),timer});
    // An explicit file survives Next's trailing-slash canonicalization and
    // keeps all relative asset paths inside this capability directory.
    return{token,url:base+'index.php',expiresAt:now()+SESSION_MS};
  }
  function headers(token){const value=session(token),origin=new URL(value.base).origin;return{
    'Cache-Control':'no-store','Cross-Origin-Opener-Policy':'same-origin','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
    'Access-Control-Allow-Origin':'null','Access-Control-Allow-Methods':'GET, HEAD, POST, OPTIONS','Access-Control-Allow-Headers':'content-type, x-requested-with',
    // Do not add allow-same-origin. A connected server must never execute its
    // web client with the Manager application's origin or session privileges.
    'Content-Security-Policy':`sandbox allow-scripts allow-forms allow-downloads; default-src 'none'; script-src ${value.base} 'unsafe-inline' 'unsafe-eval'; style-src ${value.base} 'unsafe-inline'; img-src ${value.base} data:; font-src ${value.base} data:; connect-src ${value.base}; form-action ${value.base}; frame-ancestors ${origin}; base-uri 'none'; object-src 'none'`,
  };}
  function enqueue(token,input,signal){
    const value=session(token);
    if(!['GET','HEAD','POST'].includes(input.method)||typeof input.path!=='string'||input.path.length>4096||/[\x00-\x1f\\]/.test(input.path)||input.path.startsWith('/')||input.path.split('?')[0].split('/').some(p=>p==='.'||p==='..'||p.includes(':')))throw fail('Invalid database browser request');
    let decoded;try{decoded=decodeURIComponent(input.path.split('?')[0])}catch{throw fail('Invalid database browser path')}
    if(/[\x00-\x1f\\]/.test(decoded)||decoded.startsWith('/')||decoded.split('/').some(part=>part==='.'||part==='..'||part.includes(':')))throw fail('Invalid database browser path');
    const body=Buffer.from(input.body||[]);if(body.length>LIMIT)throw fail('Database browser upload exceeds 8 MB. Use the server console for larger transfers.',413);
    // HTTP/2 loads the client's scripts concurrently. Bound queued request
    // count independently of upload bytes so assets cannot starve the UI.
    if(requests.size>=128||[...requests.values()].filter(item=>item.session.serverId===value.serverId).length>=64||[...requests.values()].reduce((total,item)=>total+item.bodyBytes,body.length)>32*1024*1024)throw fail('Database browser is busy. Retry after the current requests finish.',429);
    if(signal?.aborted)return Promise.reject(fail('Database browser request cancelled',499));
    const id=randomBytes(24).toString('base64url');
    return new Promise((resolve,reject)=>{
      const item={id,session:value,resolve,reject,signal,claimed:false,claimToken:null,bodyBytes:body.length,
        input:{method:input.method,path:input.path,body:body.toString('base64'),contentType:String(input.contentType||'').slice(0,200),accept:String(input.accept||'').slice(0,200),requestedWith:input.requestedWith==='XMLHttpRequest'?'XMLHttpRequest':'',publicBase:value.base,connection:value.connection},
        timer:setTimeout(()=>finish(id,fail('The selected server did not finish this request. It has not been replayed.',504)),timeoutMs),abort:()=>finish(id,fail('Database browser request cancelled',499))};
      requests.set(id,item);signal?.addEventListener('abort',item.abort,{once:true});const wake=waiters.get(value.serverId)?.shift();wake?.();
    });
  }
  async function claim(serverId){
    sweep();let item=[...requests.values()].find(item=>item.session.serverId===serverId&&!item.claimed);
    if(!item){await new Promise(resolve=>{const list=waiters.get(serverId)||[];if(list.length>=4){resolve();return;}let timer;const wake=()=>{clearTimeout(timer);const at=list.indexOf(wake);if(at>=0)list.splice(at,1);if(!list.length)waiters.delete(serverId);resolve();};list.push(wake);waiters.set(serverId,list);timer=setTimeout(wake,pollMs)});sweep();item=[...requests.values()].find(item=>item.session.serverId===serverId&&!item.claimed);}
    if(!item)return{request:null};item.claimed=true;item.claimToken=randomBytes(32).toString('base64url');
    return{request:{id:item.id,claimToken:item.claimToken,...item.input,cookie:[...item.session.cookies].map(([key,value])=>key+'='+value).join('; ')}};
  }
  function report(serverId,input){
    const item=requests.get(input.id);if(!item)return{ignored:true};
    if(item.session.serverId!==serverId||!item.claimed||!equal(input.claimToken,item.claimToken))throw fail('Invalid database browser receipt',403);
    if(input.error){finish(item.id,fail('The selected server could not open the database browser.',502));return{ok:true};}
    if(!Number.isInteger(input.status)||input.status<200||input.status>599||typeof input.body!=='string'||input.body.length>Math.ceil(LIMIT/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.body)||!Array.isArray(input.headers)||input.headers.length>50||JSON.stringify(input.headers).length>64000)throw fail('Invalid database browser response');
    let body=Buffer.from(input.body,'base64');const forward={};
    if(body.length>LIMIT)throw fail('Database browser response exceeds 8 MB',413);
    for(const pair of input.headers){
      if(!Array.isArray(pair)||pair.length!==2||pair.some(part=>typeof part!=='string'||/[\r\n\0]/.test(part)))throw fail('Invalid database browser headers');
      const [rawName,value]=pair,name=rawName.toLowerCase();
      if(name==='set-cookie'){
        const match=value.match(/^((?:phpMyAdmin|pma)[A-Za-z0-9_-]*)=([^;]*)/);if(!match||match[2].length>8192)continue;
        const expires=value.match(/;\s*Expires=([^;]+)/i);
        if(/;\s*Max-Age=0(?:;|$)/i.test(value)||expires&&Date.parse(expires[1])<now())item.session.cookies.delete(match[1]);
        else if(item.session.cookies.has(match[1])||item.session.cookies.size<20)item.session.cookies.set(match[1],match[2]);
      }else if(['content-type','content-disposition'].includes(name))forward[name]=value;
      else if(name==='location'){const location=new URL(value,item.session.base);if(location.origin!==new URL(item.session.base).origin||!location.href.startsWith(item.session.base))throw fail('Database browser redirect left its session');if(location.pathname===new URL(item.session.base).pathname)location.pathname+='index.php';forward.location=location.href;}
    }
    if(/^text\/html(?:;|$)/i.test(forward['content-type']||'')&&!forward['content-disposition'])body=Buffer.from(body.toString('utf8').replace(/<head(?:\s[^>]*)?>/i,head=>head+sandboxScript));
    finish(item.id,null,{status:input.status,body,headers:{...forward,...headers(item.session.base.split('/').at(-2))}});return{ok:true};
  }
  function close(token){const value=sessions.get(token);if(!value)return;clearTimeout(value.timer);sessions.delete(token);value.cookies.clear();for(const[id,item]of requests)if(item.session===value)finish(id,fail('Database browser session closed',410));}
  function inspect(token){const value=session(token);return{serverId:value.serverId,userId:value.userId,connectionId:value.connection.id};}
  return{open,headers,enqueue,claim,report,close,inspect};
}
module.exports={createRelay,LIMIT};
