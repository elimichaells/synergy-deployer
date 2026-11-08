// Synthetic API proxy for visual testing; no production credentials or databases.
const http=require('node:http'),path=require('node:path'),Module=require('node:module');
require('../register.cjs');
const root=path.resolve(__dirname,'../..'),original=Module._resolveFilename;
Module._resolveFilename=function(id,...args){return original.call(this,id.startsWith('@/')?path.join(root,id.slice(2)):id,...args)};
const fixture=require('./workspace-api.ts');
const proxy=http.createServer(async(req,res)=>{try{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  if(req.url.startsWith('/api/')){
    const request=new Request('http://127.0.0.1:4012'+req.url,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
    const handler=fixture[req.method];const response=handler?await handler(request):Response.json({error:'Fixture method unavailable'},{status:405});
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
  }
  const headers={...req.headers,cookie:'manager_session=synthetic-preview-only',host:'127.0.0.1:4011'};
  const upstream=http.request({host:'127.0.0.1',port:4011,path:req.url,method:req.method,headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)});upstream.on('error',()=>{res.writeHead(502);res.end('Preview renderer unavailable')});upstream.end(Buffer.concat(chunks));
}catch(error){res.writeHead(500);res.end(error.message)}});
proxy.listen(4012,'127.0.0.1',()=>console.log('Synthetic workspace preview: http://127.0.0.1:4012'));
