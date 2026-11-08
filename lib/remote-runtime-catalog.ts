import { ApiError } from './api'
type Asset={url:string;sha256:string;format:'zip'|'tar.xz'|'tar.gz';executable:string}
export type RemoteVersion={version:string;label:string;date?:string;asset:Asset}
const cache=new Map<string,{at:number;items:RemoteVersion[]}>()
async function json(url:string){const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000)});if(!r.ok)throw new ApiError('Official runtime catalog is unavailable',502);return r.json()}
export async function remoteRuntimeCatalog(runtime:string,platform:string,arch='x64'):Promise<RemoteVersion[]>{
  if(!['node','go','php'].includes(runtime)||!['win32','linux'].includes(platform)||!['x64','arm64'].includes(arch)||platform==='win32'&&arch!=='x64')throw new ApiError('Unsupported runtime platform',400)
  if(runtime==='php'&&platform==='linux')throw new ApiError('Linux PHP uses the distribution package or an existing custom executable path',409)
  const key=[runtime,platform,arch].join(':'),saved=cache.get(key);if(saved&&Date.now()-saved.at<300000)return saved.items
  let items:RemoteVersion[]=[]
  if(runtime==='node'){
    const releases=await json('https://nodejs.org/dist/index.json') as {version:string;date:string;lts:string|false;files:string[]}[]
    const suffix=platform==='win32'?'win-x64.zip':`linux-${arch}.tar.xz`,fileType=platform==='win32'?'win-x64-zip':`linux-${arch}`
    const seen=new Set<string>()
    const chosen=releases.filter(r=>r.lts&&Number(r.version.split('.')[0].slice(1))>=22&&r.files.includes(fileType)).filter(r=>{const major=r.version.split('.')[0];if(seen.has(major))return false;seen.add(major);return true}).slice(0,4)
    items=await Promise.all(chosen.map(async r=>{
      const name=`node-${r.version}-${suffix}`,base=`https://nodejs.org/dist/${r.version}`
      const response=await fetch(base+'/SHASUMS256.txt',{redirect:'error',signal:AbortSignal.timeout(20000)});if(!response.ok)throw new ApiError('Runtime checksum catalog is unavailable',502)
      const line=(await response.text()).split('\n').map(s=>s.trim().split(/\s+/)).find(p=>p[1]===name)
      if(!line||!/^[a-f0-9]{64}$/.test(line[0]))throw new ApiError('Runtime checksum is missing',502)
      return {version:r.version.slice(1),label:`Node.js ${r.version.slice(1)} LTS (${r.lts})`,date:r.date,asset:{url:base+'/'+name,sha256:line[0],format:platform==='win32'?'zip' as const:'tar.xz' as const,executable:platform==='win32'?`node-${r.version}-win-x64/node.exe`:`node-${r.version}-linux-${arch}/bin/node`}}
    }))
  }else if(runtime==='go'){
    const releases=await json('https://go.dev/dl/?mode=json&include=all') as {version:string;stable:boolean;files:{os:string;arch:string;kind:string;filename:string;sha256:string}[]}[]
    for(const r of releases.filter(r=>r.stable).slice(0,8)){const f=r.files.find(f=>f.os===(platform==='win32'?'windows':'linux')&&f.arch===(arch==='x64'?'amd64':'arm64')&&f.kind==='archive');if(f&&/^[a-f0-9]{64}$/.test(f.sha256))items.push({version:r.version.slice(2),label:'Go '+r.version.slice(2),asset:{url:'https://go.dev/dl/'+f.filename,sha256:f.sha256,format:platform==='win32'?'zip':'tar.gz',executable:platform==='win32'?'go/bin/go.exe':'go/bin/go'}})}
  }else{
    const releases=await json('https://downloads.php.net/~windows/releases/releases.json') as Record<string,{version:string}&Record<string,unknown>>
    for(const r of Object.values(releases)){const build=Object.entries(r).find(([key])=>/^nts-vs\d+-x64$/.test(key))?.[1] as {zip?:{path:string;sha256:string}}|undefined;const f=build?.zip;if(/^8\.[2-9]\./.test(r.version)&&f&&/^[a-f0-9]{64}$/i.test(f.sha256)&&/^php-[\w.-]+\.zip$/.test(f.path))items.push({version:r.version.replace(/-\d+$/,''),label:'PHP '+r.version+' NTS x64',asset:{url:'https://downloads.php.net/~windows/releases/'+f.path,sha256:f.sha256.toLowerCase(),format:'zip',executable:'php.exe'}})}
  }
  items.sort((a,b)=>b.version.localeCompare(a.version,undefined,{numeric:true}))
  cache.set(key,{at:Date.now(),items});return items
}
export async function remoteRuntimeAsset(runtime:string,version:string,platform:string,arch:string){
  const item=(await remoteRuntimeCatalog(runtime,platform,arch)).find(item=>item.version===version)
  if(!item)throw new ApiError('Choose a version from the current official runtime catalog',400)
  return item.asset
}
