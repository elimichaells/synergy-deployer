import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { readBody, requireSameOrigin } from '@/lib/request-body'
import { remoteConsoleHistory, queueRemoteConsole, cancelRemoteConsole } from '@/lib/remote-console'
import { updateProtected } from '@/lib/update-maintenance'
export const dynamic='force-dynamic'
type Context={params:Promise<{id:string}>}
export async function GET(request:Request,context:Context){
  try{requireRole(await getSessionFromCookie(),['admin']);return NextResponse.json(await remoteConsoleHistory((await context.params).id,new URL(request.url).searchParams.get('appId')),{headers:{'Cache-Control':'no-store'}})}catch(error){return jsonError(error)}
}
export async function POST(request:Request,context:Context){
  try{const user=await getSessionFromCookie();requireRole(user,['admin']);requireSameOrigin(request);const body=await readBody(request,16000),id=(await context.params).id;return NextResponse.json(await updateProtected('Remote console admission',async()=>body.action==='cancel'?cancelRemoteConsole(id,body.id,user!.id):queueRemoteConsole(id,typeof body.appId==='string'?body.appId:null,body,user!.id)),{status:202})}catch(error){return jsonError(error)}
}
