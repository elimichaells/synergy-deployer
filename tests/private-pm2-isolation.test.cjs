const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const agent=require('../scripts/manager-agent.cjs');
test('Windows PM2 hooks follow native and short aliases and refuse shared pipes before connecting',{skip:process.platform!=='win32'},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-pipe-hook-'));
  t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());await fs.rm(root,{recursive:true,force:true});});
  const pkg=path.join(root,'pm2-package'),cli=path.join(pkg,'bin','pm2'),source=path.join(pkg,'paths.js');
  await fs.mkdir(path.dirname(cli),{recursive:true});await fs.writeFile(cli,'');
  await fs.writeFile(source,'module.exports=home=>({PM2_HOME:home,DAEMON_RPC_PORT:"shared"})');
  const env=await agent.privatePm2Environment(root,cli),marker=await agent.readJson(path.join(root,'pm2-private-pipes.json'));
  const native=require('node:fs').realpathSync.native(source);
  const script=`const assert=require('node:assert/strict'),net=require('node:net');for(const file of ${JSON.stringify([source,native])})assert.equal(require(file)(process.env.PM2_HOME).DAEMON_RPC_PORT,${JSON.stringify(marker.prefix+'-rpc.sock')});for(const pipe of ${JSON.stringify(['\\\\.\\pipe\\rpc.sock','\\\\.\\pipe\\pub.sock','\\\\.\\pipe\\interactor.sock'])})for(const args of [[pipe],[{path:pipe}],[[{path:pipe}]]])assert.throws(()=>new net.Socket().connect(...args),/Refusing a shared PM2 pipe/);console.log('aliases and shared-pipe refusal verified');`;
  assert.match(await agent.run(process.execPath,['-e',script],{env,timeout:10000}),/verified/);
  const nativeRoot=require('node:fs').realpathSync.native(root);
  await agent.privatePm2Environment(nativeRoot,require('node:fs').realpathSync.native(cli));
  assert.deepEqual(await agent.readJson(path.join(root,'pm2-private-pipes.json')),marker,'Existing pipe registration survives alternate root spelling');
});
