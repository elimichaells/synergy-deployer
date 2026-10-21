import { receiveGitPush } from '@/lib/git-webhook-handler'
export async function POST(request: Request) { return receiveGitPush(request, 'gitea') }
