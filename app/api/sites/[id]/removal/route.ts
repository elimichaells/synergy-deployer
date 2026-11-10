import { applicationRemovalRequest } from '@/lib/application-removal-route'
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }
export async function GET(request: Request, context: Context) { return applicationRemovalRequest(request, null, (await context.params).id) }
export async function DELETE(request: Request, context: Context) { return applicationRemovalRequest(request, null, (await context.params).id) }
