import { createHmac,timingSafeEqual } from 'node:crypto'
import { repositoryUrl } from './git-provider-policy'
export function remotePush(provider:string,raw:string,headers:Headers,secret:string){
  const event=headers.get(provider==='github'?'x-github-event':provider==='gitlab'?'x-gitlab-event':'x-gitea-event')
  if(event!==(provider==='gitlab'?'Push Hook':'push'))return null
  const supplied=headers.get(provider==='github'?'x-hub-signature-256':provider==='gitlab'?'x-gitlab-token':'x-gitea-signature')||''
  const expected=provider==='gitlab'?secret:(provider==='github'?'sha256=':'')+createHmac('sha256',secret).update(raw).digest('hex')
  if(!secret||Buffer.byteLength(supplied)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))throw Error('Invalid webhook signature')
  const payload=JSON.parse(raw),repo=provider==='gitlab'?payload.project?.git_http_url:payload.repository?.clone_url,ref=payload.ref,sha=payload.after
  if(typeof ref!=='string'||!ref.startsWith('refs/heads/')||typeof repo!=='string'||typeof sha!=='string'||!/^[a-f0-9]{40,64}$/i.test(sha)||/^0+$/.test(sha)||payload.deleted)return null
  return{repository:repositoryUrl(repo),branch:ref.slice(11),sha:sha.toLowerCase()}
}
