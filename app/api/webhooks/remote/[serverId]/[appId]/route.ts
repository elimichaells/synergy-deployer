import {jsonError,ApiError} from '@/lib/api'
import {receiveRemotePush} from '@/lib/remote-git-automation'
import {updateProtected} from '@/lib/update-maintenance'
export async function POST(request:Request,context:{params:Promise<{serverId:string;appId:string}>}){try{
  const reader=request.body?.getReader();if(!reader)throw new ApiError('Missing webhook body',400)
  const chunks:Uint8Array[]=[];let size=0
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024){await reader.cancel();throw new ApiError('Webhook body is too large',413)}chunks.push(value)}
  const {serverId,appId}=await context.params
  return Response.json(await updateProtected('Remote Git push',()=>receiveRemotePush(serverId,appId,Buffer.concat(chunks).toString('utf8'),request.headers)))
}catch(error){return jsonError(error)}}
