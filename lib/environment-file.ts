import {randomUUID} from 'node:crypto'
import {open,lstat,readFile,rename,unlink} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import path from 'node:path'
import {ApiError} from './api'

/** Replace a complete file; interrupted writes leave the last saved file intact. */
export async function saveEnvironmentFile(filename:string,content:string,previousContent?:unknown){
  const inspect=()=>lstat(filename).catch(error=>{if(error.code==='ENOENT')return null;throw error})
  const before=await inspect()
  if(before&&(!before.isFile()||before.isSymbolicLink()||before.size>2_000_000))throw new ApiError('Environment file must be a regular file smaller than 2 MB',409)
  const original=before?await readFile(filename,'utf8'):''
  if(previousContent!==undefined&&previousContent!==original)throw new ApiError('This file changed elsewhere. Reload it before saving.',409)
  const temporary=path.join(path.dirname(filename),'.manager-env-'+randomUUID()+'.tmp')
  try{
    const handle=await open(temporary,'wx',before?before.mode&0o777:0o600)
    try{await handle.writeFile(content,'utf8');await handle.sync()}finally{await handle.close()}
    const current=await inspect()
    if((!!before!==!!current)||current&&(!current.isFile()||current.isSymbolicLink()||current.ino!==before!.ino||current.mtimeMs!==before!.mtimeMs||current.size!==before!.size)||current&&await readFile(filename,'utf8')!==original)throw new ApiError('This file changed elsewhere. Reload it before saving.',409)
    if(process.platform==='win32'&&before){
      // ReplaceFile preserves the destination's Windows ACL. A plain rename
      // would inherit the temporary file's permissions instead.
      const script='[IO.File]::Replace($env:MANAGER_ENV_SOURCE,$env:MANAGER_ENV_TARGET,[NullString]::Value)'
      await promisify(execFile)(path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,env:{...process.env,MANAGER_ENV_SOURCE:temporary,MANAGER_ENV_TARGET:filename}})
    }else await rename(temporary,filename)
  }finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error})}
}
