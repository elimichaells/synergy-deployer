const test=require('node:test'),assert=require('node:assert/strict');
test('native Windows PM2 counters return actual memory without WMI and reject command input',{skip:process.platform!=='win32',timeout:20000},async()=>{
  const usage=require('../scripts/windows-pidusage.cjs')();
  const row=await usage(process.pid);assert.equal(row.pid,process.pid);assert.ok(row.memory>1024*1024);assert.ok(row.ctime>=0);assert.equal(row.cpu,0);
  const rows=await new Promise((resolve,reject)=>usage([process.pid,2147483647],(error,value)=>error?reject(error):resolve(value)));assert.ok(rows[process.pid].memory>0);assert.equal(rows[2147483647],undefined);
  await assert.rejects(usage(2147483647),error=>error.code==='ENOENT');await assert.rejects(usage('1; exit'),/Invalid process IDs/);
  usage.clear();assert.equal((await usage(process.pid)).cpu,0);
});
