import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError,jsonError } from '@/lib/api'
import { requireSameOrigin,readBody } from '@/lib/request-body'
import { acquireProjectOperation } from '@/lib/project-operation'
import { updateProtected } from '@/lib/update-maintenance'
import { readFile,writeFile,lstat } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
type Context={params:Promise<{id:string}>}
async function target(id:string,file:unknown){
  if(!['.env','.env.local'].includes(String(file)))throw new ApiError('Unsupported env file',400)
  const project=(await query<{root_path:string}>('select root_path from projects where id=$1',[id])).rows[0]
  if(!project)throw new ApiError('Project not found',404)
  const filename=path.join(project.root_path,String(file)),stat=await lstat(filename).catch(error=>{if(error.code!=='ENOENT')throw error;return null})
  if(stat&&(!stat.isFile()||stat.isSymbolicLink()||stat.size>2_000_000))throw new ApiError('Environment file must be a regular file smaller than 2 MB',409)
  return{root:project.root_path,filename}
}
async function read(filename:string){return readFile(filename,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error})}
export async function GET(request:Request,context:Context){try{
  requireRole(await getSessionFromCookie(),['admin','operator'])
  const file=new URL(request.url).searchParams.get('file')||'.env',{filename}=await target((await context.params).id,file)
  return NextResponse.json({file,content:await read(filename)},{headers:{'Cache-Control':'no-store'}})
}catch(error){return jsonError(error)}}
export async function POST(request:Request,context:Context){try{
  requireRole(await getSessionFromCookie(),['admin','operator']);requireSameOrigin(request)
  const body=await readBody(request,4_000_000),id=(await context.params).id
  if(typeof body.content!=='string'||body.content.length>500000)throw new ApiError('Environment content must be text, at most 500,000 characters',400)
  return await updateProtected('Application environment settings',async()=>{
    const release=await acquireProjectOperation(id)
    try{
      const {root,filename}=await target(id,body.file||'.env')
      if(body.previousContent!==undefined&&body.previousContent!==await read(filename))throw new ApiError('This file changed elsewhere. Reload it before saving.',409)
      if(!existsSync(path.join(root,'.git'))){
        const {ensureProjectSetupSchema}=await import('@/lib/project-setup');await ensureProjectSetupSchema()
        if((await query('select project_id from project_setup where project_id=$1 and completed_at is null',[id])).rowCount)throw new ApiError('Prepare the repository in Setup before saving environment files',409)
      }
      await writeFile(filename,body.content as string,{encoding:'utf8',mode:0o600})
      return NextResponse.json({ok:true})
    }finally{await release()}
  })
}catch(error){return jsonError(error)}}
