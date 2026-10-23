import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
export const dynamic='force-dynamic'
export async function GET(request: Request) {
  try {
    await query('select 1 from users limit 1')
    return NextResponse.json({ready:true,version:process.env.NEXT_PUBLIC_MANAGER_VERSION,nonce:new URL(request.url).searchParams.get('nonce')?.slice(0,100)},{headers:{'Cache-Control':'no-store'}})
  } catch {return NextResponse.json({ready:false},{status:503,headers:{'Cache-Control':'no-store'}})}
}
