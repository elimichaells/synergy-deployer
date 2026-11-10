'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {packagePostgresRuntime}=require('../scripts/agent-postgres-runtime.cjs'),{loadPostgresRuntime}=require('../scripts/agent-runtime-loader.cjs'),{contained}=require('../scripts/manager-agent.cjs');
test('agent PostgreSQL runtime is self contained, offline and refuses cache tampering',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-pg-driver-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const archive=await packagePostgresRuntime(),pg=await loadPostgresRuntime(root,archive,{contained});assert.equal(typeof pg.Client,'function');assert.equal(pg.types.getTypeParser(23)('42'),42);assert.equal(pg.types.getTypeParser(3802)('{"ok":true}').ok,true);
  const loaded=await loadPostgresRuntime(root,archive,{contained});assert.equal(loaded,pg);
  const version=(await fs.readdir(path.join(root,'database-runtime')))[0],file=path.join(root,'database-runtime',version,'node_modules/pg/package.json');await fs.writeFile(file,'{}');await assert.rejects(loadPostgresRuntime(root,archive,{contained}),/cache changed/);
});
test('all registered database provider drivers load from a private offline runtime',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'manager-database-drivers-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const [name,entry,member] of [['mysql2','mysql2/promise','createConnection'],['mssql','mssql','ConnectionPool'],['mongodb','mongodb','MongoClient'],['redis','redis','createClient']]){
    const archive=await packagePostgresRuntime(process.cwd(),[name]),driver=await loadPostgresRuntime(root,archive,{contained},entry);assert.equal(typeof driver[member],'function');
  }
});
