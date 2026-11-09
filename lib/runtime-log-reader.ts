import { open } from 'node:fs/promises'
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
