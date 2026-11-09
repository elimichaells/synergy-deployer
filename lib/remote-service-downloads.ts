import { createHash } from 'node:crypto'
import { ApiError } from './api'
import { installerDownloads } from './server-ssh'
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
export async function serviceDownloads(service:string,platform:string,arch:string){
  if(!['win32','linux'].includes(platform)||!['x64','arm64'].includes(arch)||platform==='win32'&&arch!=='x64')throw new ApiError('Automatic service installation supports Windows x64 and Linux x64/ARM64',400)
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
