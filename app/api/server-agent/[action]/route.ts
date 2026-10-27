import { NextResponse } from 'next/server'
import { ApiError, jsonError } from '@/lib/api'
import { authenticateAgent, claimJob, enroll, heartbeat, reportJob } from '@/lib/managed-servers'
import { readBody } from '@/lib/request-body'
import { claimAgentUpdate, reportAgentUpdate } from '@/lib/remote-agent-updates'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  try {
    const { action } = await context.params
    if (action === 'enroll') return NextResponse.json(await enroll(await readBody(request, 4096)), { headers: { 'Cache-Control': 'no-store' } })
    const server = await authenticateAgent(request)
    let result
    if (action === 'heartbeat') result = await heartbeat(server, await readBody(request))
    else if (action === 'claim') result = await claimJob(server.id)
    else if (action === 'report') result = await reportJob(server.id, await readBody(request, 800_000))
    else if (action === 'update-claim') result = await claimAgentUpdate(server.id, await readBody(request,4096))
    else if (action === 'update-report') result = await reportAgentUpdate(server.id, await readBody(request,4096))
    else throw new ApiError('Unknown agent operation', 404)
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return jsonError(error) }
}
