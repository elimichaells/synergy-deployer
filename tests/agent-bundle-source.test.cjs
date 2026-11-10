'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const {agentBundle}=require('../scripts/agent-bundle.cjs');

test('Windows preload uses source bytes even when the server compiler rewrites module functions',async t=>{
  const temp=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(temp,'manager-bundle-source-'));
  t.after(async()=>{assert.equal(path.dirname(await fs.realpath(root)),temp);await fs.rm(root,{recursive:true,force:true});});
  const id=require.resolve('../scripts/windows-pidusage.cjs');require(id);const original=require.cache[id].exports;
  // Production webpack binds builtin imports outside the exported function.
  // Serializing that function would produce an invalid standalone preload.
  require.cache[id].exports=function compiledCounterFactory(){return missingWebpackBinding();};
  let bundle;try{bundle=await agentBundle();}finally{require.cache[id].exports=original;}
  const file=path.join(root,'manager-agent.cjs');await fs.writeFile(file,bundle);
  const fakePm2=path.join(root,'pm2-package','bin','pm2');await fs.mkdir(path.dirname(fakePm2),{recursive:true});await fs.writeFile(fakePm2,'');await fs.writeFile(path.join(root,'pm2-package','paths.js'),'module.exports=()=>({});');
  const env=await require(file).privatePm2Environment(root,fakePm2,'win32');
  const {stdout}=await promisify(execFile)(process.execPath,['-e','console.log("preload-ok")'],{windowsHide:true,env,timeout:15000});
  assert.equal(stdout.trim(),'preload-ok');
  assert.ok(!bundle.includes('missingWebpackBinding'));
});
