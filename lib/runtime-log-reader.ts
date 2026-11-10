import { open,lstat,readFile } from 'node:fs/promises'
import path from 'node:path'
import {parseEnvironmentText} from './environment-text'
export async function runtimeLogSecrets(root:string,processEnvironment:Record<string,unknown>={}){
  const values:Record<string,unknown>={...processEnvironment}
  for(const name of ['.env','.env.local','.env.production','.env.production.local']){
    const filename=path.join(root,name)
    try{const info=await lstat(filename);if(!info.isFile()||info.isSymbolicLink()||info.size>200000)throw Error('Application environment cannot be safely read');Object.assign(values,parseEnvironmentText(await readFile(filename,'utf8')))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  }
  return Object.entries(values).flatMap(([key,value])=>typeof value==='string'&&value&&(value.length>=4||/secret|password|token|api.?key/i.test(key))?[value]:[])
}
export function redactRuntimeLog(content:string,secrets:string[]){
  const values=new Set<string>()
  for(const value of secrets){values.add(value);values.add(encodeURIComponent(value));values.add(JSON.stringify(value).slice(1,-1));try{const url=new URL(value);if(url.password){values.add(url.password);values.add(decodeURIComponent(url.password))}}catch{}}
  for(const value of [...values].filter(Boolean).sort((a,b)=>b.length-a.length))content=content.split(value).join('[redacted]')
  return content
}
/** Bound memory and I/O even for multi-gigabyte process logs. */
export async function tailRuntimeLog(filename:string,lines=200){
  const handle=await open(filename,'r')
  try{
    const stat=await handle.stat();if(!stat.isFile())throw Error('Log is not a regular file')
    const size=Math.min(stat.size,65536),buffer=Buffer.alloc(size)
    const {bytesRead}=await handle.read(buffer,0,size,Math.max(0,stat.size-size))
    let content=buffer.subarray(0,bytesRead).toString('utf8')
    if(stat.size>size)content=content.slice(content.indexOf('\n')+1)
    return content.split(/\r?\n/).slice(-Math.max(1,Math.min(2000,Number.isFinite(lines)?lines:200))).join('\n')
  }finally{await handle.close()}
}
