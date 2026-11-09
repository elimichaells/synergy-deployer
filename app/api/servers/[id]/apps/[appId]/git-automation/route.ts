import {NextResponse} from 'next/server'
import {jsonError} from '@/lib/api'
import {getSessionFromCookie} from '@/lib/auth'
import {requireRole} from '@/lib/rbac'
import {readBody,requireSameOrigin} from '@/lib/request-body'
import {updateProtected} from '@/lib/update-maintenance'
import {remoteGitStatus,changeRemoteGit} from '@/lib/remote-git-automation'
type Context={params:Promise<{id:string;appId:string}>}
export async function GET(_request:Request,context:Context){try{requireRole(await getSessionFromCookie(),['admin']);const {id,appId}=await context.params;return NextResponse.json(await remoteGitStatus(id,appId),{headers:{'Cache-Control':'no-store'}})}catch(error){return jsonError(error)}}
export async function POST(request:Request,context:Context){try{const user=await getSessionFromCookie();requireRole(user,['admin']);requireSameOrigin(request);const body=await readBody(request,4000),{id,appId}=await context.params;return NextResponse.json(await updateProtected('Remote Git automation',()=>changeRemoteGit(id,appId,body,user!.id)),{headers:{'Cache-Control':'no-store'}})}catch(error){return jsonError(error)}}
