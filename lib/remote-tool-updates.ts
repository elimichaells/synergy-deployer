type Update={latestVersion:string|null;updateCheckedAt:string|null;updateCheckSupported:boolean;updateCheckError:string|null;updateSourceUrl:string|null}
const results=new Map<string,{at:number;value:Update}>(),catalogs=new Map<string,{at:number;value:unknown}>()
const gh=(repository:string,path='releases/latest')=>`https://api.github.com/repos/${repository}/${path}`
const sources:Record<string,{url:string;page:string;kind:'tag'|'tags'|'refs'|'npm'|'composer'|'phpmyadmin'|'php'}>={
  caddy:{url:gh('caddyserver/caddy'),page:'https://github.com/caddyserver/caddy/releases',kind:'tag'},
  pm2:{url:'https://registry.npmjs.org/pm2/latest',page:'https://www.npmjs.com/package/pm2',kind:'npm'},
  angular:{url:'https://registry.npmjs.org/@angular%2fcli/latest',page:'https://www.npmjs.com/package/@angular/cli',kind:'npm'},
  composer:{url:'https://getcomposer.org/versions',page:'https://getcomposer.org/download/',kind:'composer'},
  sling:{url:gh('slingdata-io/sling-cli'),page:'https://github.com/slingdata-io/sling-cli/releases',kind:'tag'},
  phpmyadmin:{url:'https://www.phpmyadmin.net/home_page/version.json',page:'https://www.phpmyadmin.net/downloads/',kind:'phpmyadmin'},
  python:{url:gh('python/cpython','tags?per_page=100'),page:'https://www.python.org/downloads/',kind:'tags'},
  postgresql:{url:gh('postgres/postgres','tags?per_page=100'),page:'https://www.postgresql.org/support/versioning/',kind:'tags'},
  mysql:{url:gh('mysql/mysql-server','tags?per_page=100'),page:'https://dev.mysql.com/downloads/mysql/',kind:'tags'},
  mariadb:{url:gh('MariaDB/server','tags?per_page=100'),page:'https://mariadb.org/download/',kind:'tags'},
  mongodb:{url:gh('mongodb/mongo','tags?per_page=100'),page:'https://www.mongodb.com/try/download/community',kind:'tags'},
  redis:{url:gh('redis/redis','tags?per_page=100'),page:'https://redis.io/downloads/',kind:'tags'},
  sqlserver:{url:gh('microsoft/go-sqlcmd'),page:'https://github.com/microsoft/go-sqlcmd/releases',kind:'tag'},
}
export function detectedToolVersion(id:string,value:string){
  if(id==='composer')return value.match(/\bComposer(?:\s+version)?\s+(\d+\.\d+\.\d+)\b/i)?.[1]||value.trim().match(/^\d+\.\d+\.\d+$/)?.[0]||null
  if(['mariadb','mysql'].includes(id)&&/MariaDB/i.test(value))return value.match(/(?:Distrib\s+)?(\d+\.\d+\.\d+)(?:-[^\s]*)?-MariaDB/i)?.[1]||value.match(/Distrib\s+(\d+\.\d+\.\d+)/i)?.[1]||null
  if(id==='mysql')return value.match(/\bVer\s+(\d+\.\d+\.\d+)/i)?.[1]||value.match(/\d+\.\d+\.\d+/)?.[0]||null
  return value.match(/\d+\.\d+(?:\.\d+)?/)?.[0]||null
}
export function updateRisk(current:string,latest:string):'major'|'minor'|'patch'{const a=current.split('.'),b=latest.split('.');return a[0]!==b[0]?'major':a[1]!==b[1]?'minor':'patch'}
export function releaseVersion(id:string,kind:string,data:any,current:string){
  let versions:string[]=[]
  if(kind==='tags'||kind==='refs')versions=(Array.isArray(data)?data:[]).map(item=>String(kind==='refs'?item.ref||'':item.name||'').replace(/^refs\/tags\//,'')).map(tag=>id==='postgresql'?tag.replace(/^REL_/,'').replaceAll('_','.'):tag.replace(/^(?:mysql-|mariadb-|v|r)/,'')).filter(value=>/^\d+\.\d+(?:\.\d+)?$/.test(value))
  else{const version=kind==='composer'?data?.stable?.[0]?.version:kind==='tag'?data?.tag_name:data?.version;versions=[String(version||'').replace(/^v/,'').replace(/\.windows\.\d+$/,'')]}
  versions=versions.filter(value=>/^\d+\.\d+(?:\.\d+)?$/.test(value))
  // Database and interpreter patch releases stay on the installed series.
  // SQL Server is the sqlcmd client inventory, not a database-engine update.
  const parts=id==='postgresql'?1:['mysql','mariadb','mongodb','redis','python','php'].includes(id)?2:0
  if(parts)versions=versions.filter(value=>value.split('.').slice(0,parts).join('.')===current.split('.').slice(0,parts).join('.'))
  versions.sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}))
  if(!versions[0])throw Error('No compatible stable release was returned by the vendor catalog')
  return versions[0]
}
async function catalog(url:string){const saved=catalogs.get(url);if(saved&&Date.now()-saved.at<300000)return saved.value;const response=await fetch(url,{redirect:'error',headers:{'User-Agent':'Manager-Runtime-Updater','Accept':'application/json'},signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('The vendor catalog is unavailable');const value=await response.json();catalogs.set(url,{at:Date.now(),value});return value}
export async function remoteToolUpdate(id:string,platform:string,version:string|null,check=false):Promise<Update>{
  const empty:Update={latestVersion:null,updateCheckedAt:null,updateCheckSupported:false,updateCheckError:null,updateSourceUrl:null}
  if(id==='redis'&&platform==='win32')return {...empty,updateCheckError:'Check the licensed Memurai installation for vendor updates.'}
  if(id==='mysql'&&/MariaDB/i.test(version||''))id='mariadb'
  const current=detectedToolVersion(id,version||'')
  let source=id==='git'?{url:platform==='win32'?gh('git-for-windows/git'):gh('git/git','tags?per_page=100'),page:'https://git-scm.com/downloads',kind:platform==='win32'?'tag':'tags'}:id==='php'&&current?{url:`https://www.php.net/releases/?json&version=${current.split('.').slice(0,2).join('.')}`,page:'https://www.php.net/downloads.php',kind:'php'}:sources[id]
  // These repositories contain unrelated historical/cluster tags before current
  // server releases. Query the installed series rather than the first tag page.
  if(current&&['mysql','mariadb'].includes(id))source={...sources[id],url:gh(id==='mysql'?'mysql/mysql-server':'MariaDB/server',`git/matching-refs/tags/${id}-${current.split('.').slice(0,2).join('.')}.`),kind:'refs'}
  if(!source)return empty
  const base={...empty,updateCheckSupported:true,updateSourceUrl:source.page},key=[id,platform,current].join(':')
  const saved=results.get(key);if(!check)return saved&&Date.now()-saved.at<3600000?saved.value:base
  if(!current)return base
  let value:Update
  try{value={...base,latestVersion:releaseVersion(id,source.kind,await catalog(source.url),current),updateCheckedAt:new Date().toISOString()}}
  catch(error){value={...base,updateCheckError:error instanceof Error?error.message:'Update check failed'}}
  if(results.size>=1000)results.delete(results.keys().next().value!)
  results.set(key,{at:Date.now(),value});return value
}
