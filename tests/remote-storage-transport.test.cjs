const test=require('node:test'),assert=require('node:assert/strict'),load=require('./server-module.cjs');
test('project service creation awaits the selected agent and returns its confirmed service ID for sharing',async t=>{
  const original=global.fetch;t.after(()=>global.fetch=original);
  const paths=[];let status='queued',polls=0;
  global.fetch=async(url)=>{paths.push(url);polls++;return Response.json({job:{status:polls===1?'running':status,result:{ok:true},log:status==='failed'?'Provisioning failed':''}})};
  const {infrastructureResponse}=load('lib/infrastructure-client.ts',{});
  const response=()=>Response.json({jobId:'job',service:{id:'new-service'}});
  status='success';const result=await infrastructureResponse(response(),'/api/servers/selected/infrastructure');
  assert.equal(polls,2);assert.equal(result.service.id,'new-service');assert.ok(paths.every(path=>path==='/api/servers/selected/infrastructure/jobs/job'));
  status='failed';await assert.rejects(infrastructureResponse(response(),'/api/servers/selected/infrastructure'),/Provisioning failed/);
  const controller=new AbortController();controller.abort();await assert.rejects(infrastructureResponse(response(),'/api/servers/selected/infrastructure',controller.signal),{name:'AbortError'});
});
