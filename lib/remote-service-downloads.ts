import { createHash } from 'node:crypto'
import { ApiError } from './api'
import { installerDownloads } from './server-ssh'
import offlineAssets from '../installer/offline/dependencies.lock.json'
const archives={
  postgresql:'https://get.enterprisedb.com/postgresql/postgresql-18.6-5-windows-x64-binaries.zip',
  mysql:'https://cdn.mysql.com/Downloads/MySQL-8.4/mysql-8.4.13-winx64.zip',
  mariadb:'https://archive.mariadb.org/mariadb-11.4.13/winx64-packages/mariadb-11.4.13-winx64.zip',
}
const cache=new Map<string,{url:string;sha256:string}>()
async function officialAsset(url:string){
  if(cache.has(url))return cache.get(url)!
  // Hash the exact bytes received over verified HTTPS from the fixed vendor URL.
  // The target verifies the same SHA-256; browser input never selects a download URL.
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(600000)})
  if(!response.ok||!response.body)throw new ApiError('Official service download is unavailable',502)
  const reader=response.body.getReader(),hash=createHash('sha256');let size=0
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>800*1024*1024)throw new Error('Installer archive exceeds its size limit');hash.update(part.value)}}finally{await reader.cancel()}
  if(size<1000)throw new ApiError('Official service archive is empty',502)
  const asset={url,sha256:hash.digest('hex')};cache.set(url,asset);return asset
}
export async function serviceDownloads(service:string,platform:string,arch:string,distribution?:{id:string;version:string}){
  if(!['win32','linux'].includes(platform)||!['x64','arm64'].includes(arch)||platform==='win32'&&arch!=='x64')throw new ApiError('Automatic service installation supports Windows x64 and Linux x64/ARM64',400)
  if(service==='sqlserver'){
    if(platform!=='win32')throw new ApiError('Reuse an existing SQL Server installation on Linux. Automatic SQL Server Express installation requires Windows x64.',400)
    const assets=Object.fromEntries(['sqlserver','sqlserver-update','vcredist'].map(id=>{const asset=offlineAssets.artifacts.find(a=>a.id===id);if(!asset)throw new ApiError('SQL Server package is missing from this Manager build',503);return[id,asset]}))
    return{...assets,sqlcmd:{url:'https://github.com/microsoft/go-sqlcmd/releases/download/v1.10.0/sqlcmd-windows-amd64.zip',sha256:'a4c28332fcc6e497d655e53ac8f4939f4ab170f9cfd32d0fa5081b60f4d9d691'}}
  }
  if(service==='mongodb'){
    // MongoDB's official full.json catalog, Community 8.0.34 (not Enterprise).
    const distro=distribution?.id==='ubuntu'&&['22.04','24.04'].includes(distribution.version)?'ubuntu'+distribution.version.replace('.',''):distribution?.id==='debian'&&distribution.version==='12'?'debian12':''
    const checksums:Record<string,string>={'windows-x64':'6b021a0864494e4decf278b36477a29eb36072432773e4e62c2f42c302630db0','ubuntu2204-x64':'8eef2a821651ac20f732b6636731a51b407675674ced8d7f1f1578ebc7aced43','ubuntu2204-arm64':'fe918ca853000d5b48fcd3b2bc6119c72f4aab9e2b04a9a10e42923cb3aef6a4','ubuntu2404-x64':'3e55cdcf7013fbc805d29d8195230df4b23c7688733ee15ad58ac6bc2a416611','ubuntu2404-arm64':'52655dd90adf0dbcbb87011075233285f44e262048ea30a9a48ad2a834c67736','debian12-x64':'0e869e044162d101d4ee468e89bc139628c4c9e041bdcdaec19bf99331827215'}
    const sha256=checksums[(platform==='win32'?'windows':distro)+'-'+arch]
    if(!sha256)throw new ApiError('Automatic MongoDB installation supports Windows x64, Ubuntu 22.04/24.04 and Debian 12 x64. Reuse an existing MongoDB path on this operating system.',400)
    const core=platform==='linux'?await installerDownloads(platform,arch,['node']):{}
    return{...core,...(platform==='linux'?{privilegedNode:(core as {node:unknown}).node}:{}),mongodb:{url:platform==='win32'?'https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-8.0.34.zip':`https://fastdl.mongodb.org/linux/mongodb-linux-${arch==='arm64'?'aarch64':'x86_64'}-${distro}-8.0.34.tgz`,sha256},...(platform==='win32'?{vcredist:{url:'https://download.visualstudio.microsoft.com/download/pr/990c720a-46ce-4dc7-87b9-c2eb615d34b9/CC0FF0EB1DC3F5188AE6300FAEF32BF5BEEBA4BDD6E8E445A9184072096B713B/VC_redist.x64.exe',sha256:'cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b'}}:{})}
  }
  if(service==='angular'){
    const core=platform==='linux'?await installerDownloads(platform,arch,['node']):{}
    return{...core,...(platform==='linux'?{privilegedNode:(core as {node:unknown}).node}:{}),angularVersion:'21.2.29'}
  }
  if(service==='sling'){
    // Pinned official release assets; GitHub release digests and the release's
    // per-platform checksum manifests agree. Never take URLs from browser input.
    const key=platform==='win32'?'windows_amd64':arch==='arm64'?'linux_arm64':'linux_amd64'
    const sha256={windows_amd64:'8bddef2259d3db6ba4e44dfc1c18ee52ae0c38537f0d9d050c509700dcdf86ae',linux_amd64:'d71b77cb49abb8f35339b425920d53ec00f639430377ccb31cf1d1691e762a88',linux_arm64:'de57360c1a0bf6c74692dc7e71b8003932f46bca8e6854db7f8da32345668388'}[key]
    const core=platform==='linux'?await installerDownloads(platform,arch,['node']):{}
    return{...core,...(platform==='linux'?{privilegedNode:(core as {node:unknown}).node}:{}),sling:{url:`https://github.com/slingdata-io/sling-cli/releases/download/v1.5.23/sling_${key}.tar.gz`,sha256}}
  }
  if(platform==='linux'){
    const core=await installerDownloads(platform,arch,['node',...(['git','caddy','pm2'].includes(service)?[service]:[])])
    return {...core,privilegedNode:core.node}
  }
  if(['node','git','caddy','pm2'].includes(service))return installerDownloads(platform,arch,[service])
  if(platform==='win32'){
    if(service in archives)return {archive:await officialAsset(archives[service as keyof typeof archives])}
    return {chocolatey:await officialAsset('https://community.chocolatey.org/install.ps1')}
  }
  return {}
}
