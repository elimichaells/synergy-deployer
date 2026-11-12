import {createHash} from 'node:crypto'
import {ApiError} from './api'
import {installerDownloads} from './server-ssh'
import {validate} from '../scripts/service-upgrade-policy.cjs'

const cache=new Map<string,{url:string;sha256:string}>()
async function json(url:string){const response=await fetch(url,{headers:{'User-Agent':'Manager-Service-Updater'},signal:AbortSignal.timeout(30000)});if(!response.ok)throw new ApiError('The official release catalog is unavailable',502);return response.json()}
async function asset(url:string,expected?:string){
  if(!/^https:\/\//.test(url))throw new Error('Invalid official asset URL')
  if(expected&&/^[a-f0-9]{64}$/i.test(expected))return {url,sha256:expected.toLowerCase()}
  if(cache.has(url))return cache.get(url)!
  const response=await fetch(url,{signal:AbortSignal.timeout(600000)});if(!response.ok||!response.body)throw new ApiError('The official update archive is unavailable',502)
  const hash=createHash('sha256');let size=0;for await(const chunk of response.body as any){size+=chunk.length;if(size>800*1024*1024)throw new Error('Update archive exceeds its size limit');hash.update(chunk)}
  if(size<1000)throw new Error('The official update archive is empty')
  const result={url,sha256:hash.digest('hex')};if(cache.size>100)cache.clear();cache.set(url,result);return result
}
async function github(repo:string,tag:string,match:(name:string)=>boolean){
  const release=await json(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`)
  if(release.draft||release.prerelease)throw new Error('Only stable published releases can be installed')
  const candidates=release.assets.filter((a:any)=>match(a.name));if(candidates.length!==1)throw new Error('No unique official archive matches this platform')
  const a=candidates[0];return {...await asset(a.browser_download_url,String(a.digest||'').replace(/^sha256:/,'')),name:a.name}
}
export async function serviceUpgradeDownloads(service:string,current:string,version:string,platform:string,arch:string,distribution?:{id:string;version:string}){
  validate(service,current,version,platform)
  if(!['x64','arm64'].includes(arch)||platform==='win32'&&arch!=='x64')throw new ApiError('This update requires Windows x64 or Linux x64/ARM64',400)
  const windows=platform==='win32',cpu=arch==='x64'?'amd64':'arm64',core=windows?{}:await installerDownloads(platform,arch,['node'])
  let update:any
  if(service==='phpmyadmin'){
    const name=`phpMyAdmin-${version}-all-languages`,url=`https://files.phpmyadmin.net/phpMyAdmin/${version}/${name}.zip`
    const response=await fetch(url+'.sha256',{signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('The phpMyAdmin checksum is unavailable');const checksum=(await response.text()).trim().match(/^([a-f0-9]{64})(?:\s|$)/i)?.[1];if(!checksum)throw new Error('Invalid phpMyAdmin checksum')
    update={...await asset(url,checksum),format:'zip',root:name,version}
  }else if(service==='caddy')update={...await github('caddyserver/caddy','v'+version,n=>n===`caddy_${version}_${windows?'windows':'linux'}_${cpu}.${windows?'zip':'tar.gz'}`),format:windows?'zip':'tar.gz',root:'',executable:windows?'caddy.exe':'caddy'}
  else if(service==='sling')update={...await github('slingdata-io/sling-cli','v'+version,n=>n===`sling_${windows?'windows':'linux'}_${cpu}.tar.gz`),format:'tar.gz',root:'',executable:windows?'sling.exe':'sling'}
  else if(service==='sqlserver')update={...await github('microsoft/go-sqlcmd','v'+version,n=>n===`sqlcmd-${windows?'windows':'linux'}-${cpu}.${windows?'zip':'tar.bz2'}`),format:windows?'zip':'tar.bz2',root:'',executable:windows?'sqlcmd.exe':'sqlcmd'}
  else if(service==='git'){
    const releases=await json('https://api.github.com/repos/git-for-windows/git/releases?per_page=30');const release=releases.find((r:any)=>!r.prerelease&&!r.draft&&new RegExp('^v'+version.replaceAll('.','\\.')+'\\.windows\\.').test(r.tag_name));if(!release)throw new Error('The selected Git release is unavailable')
    update={...await github('git-for-windows/git',release.tag_name,n=>/^MinGit-.*-64-bit\.zip$/.test(n)&&!n.includes('busybox')),format:'zip',root:'',executable:'cmd/git.exe'}
  }else if(service==='composer')update={...await asset(`https://getcomposer.org/download/${version}/composer.phar`),format:'file',root:'',executable:'composer.phar'}
  else if(service==='pm2'||service==='angular'){
    const name=service==='pm2'?'pm2':'@angular/cli',entry=await json(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`);if(entry.version!==version||!entry.dist?.integrity?.startsWith('sha512-'))throw new Error('The npm release has no verified integrity');update={package:name,version,integrity:entry.dist.integrity,format:'npm'}
  }else if(service==='postgresql'){
    // EDB build suffixes are vendor packaging revisions, not PostgreSQL versions.
    let found;for(const build of [5,4,3,2,1]){const url=`https://get.enterprisedb.com/postgresql/postgresql-${version}-${build}-windows-x64-binaries.zip`;const response=await fetch(url,{method:'HEAD',signal:AbortSignal.timeout(15000)});if(response.ok){found=url;break}}
    if(!found)throw new Error('The PostgreSQL binary release is unavailable');update={...await asset(found),format:'zip',root:'pgsql',executable:'bin/psql.exe',engine:'bin/postgres.exe',directories:['bin','lib','share']}
  }else if(service==='mysql'||service==='mariadb'){
    const url=service==='mysql'?`https://cdn.mysql.com/Downloads/MySQL-${version.split('.').slice(0,2).join('.')}/mysql-${version}-winx64.zip`:`https://archive.mariadb.org/mariadb-${version}/winx64-packages/mariadb-${version}-winx64.zip`
    update={...await asset(url),format:'zip',root:`${service}-${version}-winx64`,executable:`bin/${service}.exe`,engine:`bin/${service==='mysql'?'mysqld':'mariadbd'}.exe`,directories:['bin','lib','share']}
  }else if(service==='mongodb'){
    const catalog=await json('https://downloads.mongodb.org/full.json'),release=catalog.versions.find((r:any)=>r.version===version)
    const target=windows?'windows':distribution?.id==='ubuntu'?'ubuntu'+distribution.version.replace('.',''):distribution?.id==='debian'?'debian'+distribution.version:''
    const item=release?.downloads.find((d:any)=>d.target===target&&['archive','zip','tgz'].includes(d.archive?.url?.endsWith('.zip')?'zip':d.archive?.url?.endsWith('.tgz')?'tgz':'')&&(d.arch=== (arch==='arm64'?'aarch64':'x86_64'))&&d.edition==='targeted')||release?.downloads.find((d:any)=>d.target===target&&d.arch===(arch==='arm64'?'aarch64':'x86_64')&&['community','base'].includes(d.edition))
    if(!item?.archive?.url||!item.archive.url.startsWith('https://fastdl.mongodb.org/'))throw new Error('The MongoDB Community archive is unavailable for this operating system')
    update={...await asset(item.archive.url,item.archive.sha256),format:windows?'zip':'tar.gz',root:'single',executable:windows?'bin/mongod.exe':'bin/mongod',engine:windows?'bin/mongod.exe':'bin/mongod',directories:['bin']}
  }else if(service==='redis')update={...await asset(`https://download.redis.io/releases/redis-${version}.tar.gz`),format:'tar.gz',root:`redis-${version}`,executable:'src/redis-cli',engine:'src/redis-server',directories:['src'],build:true}
  else throw new Error('Unsupported service update')
  return {...core,...(!windows?{privilegedNode:(core as {node:unknown}).node}:{}),update:{...update,version}}
}
