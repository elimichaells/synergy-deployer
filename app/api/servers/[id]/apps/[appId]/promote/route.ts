import {NextResponse} from 'next/server'
import {jsonError} from '@/lib/api'
import {getSessionFromCookie} from '@/lib/auth'
import {requireRole} from '@/lib/rbac'
import {readBody,requireSameOrigin} from '@/lib/request-body'
import {updateProtected} from '@/lib/update-maintenance'
import {remotePromotionPlan,promoteRemoteApplication} from '@/lib/remote-promotion'
type Context={params:Promise<{id:string;appId:string}>}
export const dynamic='force-dynamic'
export async function GET(_request:Request,context:Context){try{const user=await getSessionFromCookie();requireRole(user,['admin','operator','viewer']);const{id,appId}=await context.params;return NextResponse.json({plan:await remotePromotionPlan(id,appId)},{headers:{'Cache-Control':'no-store'}})}catch(error){return jsonError(error)}}
export async function POST(request:Request,context:Context){try{const user=await getSessionFromCookie();requireRole(user,['admin','operator']);requireSameOrigin(request);const body=await readBody(request,4000),{id,appId}=await context.params;return NextResponse.json(await updateProtected('Promote remote application',()=>promoteRemoteApplication(id,appId,body,user!.id)))}catch(error){return jsonError(error)}}
