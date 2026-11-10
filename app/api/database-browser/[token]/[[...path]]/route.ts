import {databaseBrowser,authorizeDatabaseBrowser,LIMIT} from '@/lib/database-browser'
export const runtime='nodejs'
export const dynamic='force-dynamic'
export const maxDuration=60
type Context={params:Promise<{token:string;path?:string[]}>}
async function serve(request:Request,context:Context){try{
  const {token}=await context.params;await authorizeDatabaseBrowser(token)
  const headers=databaseBrowser.headers(token)
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers})
  if(Number(request.headers.get('content-length'))>LIMIT)throw Object.assign(Error('Database browser uploads are limited to 8 MB'),{status:413})
  const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let size=0
  if(reader)try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>LIMIT)throw Object.assign(Error('Database browser uploads are limited to 8 MB'),{status:413});chunks.push(value)}}finally{await reader.cancel()}
  const url=new URL(request.url),prefix='/api/database-browser/'+token+'/'
  if(!url.pathname.startsWith(prefix))throw Object.assign(Error('Invalid database browser path'),{status:400})
  const response=await databaseBrowser.enqueue(token,{method:request.method,path:url.pathname.slice(prefix.length)+url.search,body:Buffer.concat(chunks),contentType:request.headers.get('content-type'),accept:request.headers.get('accept'),requestedWith:request.headers.get('x-requested-with')},request.signal)
  return new Response(request.method==='HEAD'?null:new Uint8Array(response.body),{status:response.status,headers:response.headers})
}catch(error){const status=Number((error as {status?:number}).status)||500;return new Response(status===500?'Database browser is unavailable':(error as Error).message,{status:status>=400&&status<=599?status:500,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"sandbox; default-src 'none'",'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}})}}
export const GET=serve,POST=serve,HEAD=serve,OPTIONS=serve
