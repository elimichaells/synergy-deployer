import {NextResponse} from 'next/server'
import {getSessionFromCookie} from '@/lib/auth'
import {requireRole} from '@/lib/rbac'
import {requireSameOrigin} from '@/lib/request-body'
import {readBody} from '@/lib/request-body'
import {jsonError} from '@/lib/api'
import {openDatabaseBrowser,closeDatabaseBrowser} from '@/lib/database-browser'
export const dynamic='force-dynamic'
type Context={params:Promise<{id:string}>}
export async function POST(request:Request,context:Context){try{const user=await getSessionFromCookie();requireRole(user,['admin']);requireSameOrigin(request);const body=await readBody(request,4096),{id}=await context.params;return NextResponse.json(await openDatabaseBrowser(id,String(body.connectionId||''),request.headers.get('origin')!,user!.id),{headers:{'Cache-Control':'no-store'}})}catch(error){return jsonError(error)}}
export async function DELETE(request:Request,context:Context){try{const user=await getSessionFromCookie();requireRole(user,['admin']);requireSameOrigin(request);const body=await readBody(request,4096);await closeDatabaseBrowser(String(body.token||''),(await context.params).id,user!.id);return NextResponse.json({ok:true})}catch(error){return jsonError(error)}}
