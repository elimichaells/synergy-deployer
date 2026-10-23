import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { readBody, requireSameOrigin } from '@/lib/request-body'
import { latestRelease, prepareUpdate, updateAction, updateStatus } from '@/lib/manager-updates'
export const runtime='nodejs'
export const dynamic='force-dynamic'
export const maxDuration=1800
export async function GET(request: Request) {
  try {
    const user=await getSessionFromCookie();requireRole(user,['admin'])
    const result=new URL(request.url).searchParams.get('check')==='1'?await latestRelease():await updateStatus()
    return NextResponse.json(result,{headers:{'Cache-Control':'no-store'}})
  } catch(error){return jsonError(error)}
}
export async function POST(request: Request) {
  try {
    const user=await getSessionFromCookie();requireRole(user,['admin']);requireSameOrigin(request)
    if(request.headers.get('content-type')?.split(';')[0]==='application/octet-stream') {
      return NextResponse.json(await prepareUpdate(request.body,'offline',user!.id))
    }
    const body=await readBody(request,2000)
    const result=body.action==='download'?await prepareUpdate(null,'github',user!.id):await updateAction(body.action,body.id,user!.id)
    return NextResponse.json(result)
  } catch(error){return jsonError(error)}
}
