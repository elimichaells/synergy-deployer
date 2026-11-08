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
