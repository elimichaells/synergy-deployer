import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError,jsonError } from '@/lib/api'
import { requireSameOrigin } from '@/lib/request-body'
import { listRemoteRuntimes,remoteRuntimeVersions,remoteRuntimeJob } from '@/lib/remote-runtimes'
export const dynamic='force-dynamic'
type Context={params:Promise<{id:string;path?:string[]}>}
export async function GET(request:Request,context:Context){try{requireRole(await getSessionFromCookie(),['admin','operator','viewer']);const {id,path=[]}=await context.params;const value=path[0]==='jobs'&&path[1]?await remoteRuntimeJob(id,path[1]):path[0]==='versions'?await remoteRuntimeVersions(id,new URL(request.url).searchParams.get('runtime')||''):{runtimes:await listRemoteRuntimes(id)};return NextResponse.json(value,{headers:{'Cache-Control':'no-store'}})}catch(error){return jsonError(error)}}
export async function POST(request:Request,context:Context){try{requireRole(await getSessionFromCookie(),['admin']);requireSameOrigin(request);const {id,path=[]}=await context.params;if(path[0]!=='check-updates')throw new ApiError('Choose an installation from the reviewed SSH workflow',400);return NextResponse.json({runtimes:await listRemoteRuntimes(id,true)},{headers:{'Cache-Control':'no-store'}})}catch(error){return jsonError(error)}}
