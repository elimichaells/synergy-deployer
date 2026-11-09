const fs=require('node:fs'),assert=require('node:assert/strict'),result=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
assert.equal(result.status,'passed',result.error);assert.equal(result.version,process.env.LAB_RELEASE);assert.equal(result.runId,process.env.GITHUB_RUN_ID);assert.ok(new Date(result.bootAfter)>new Date(result.bootBefore));
for(const key of ['automaticStartup','httpsLogin','localCaStable','privateDatabaseListeners','databasesHealthy','administratorLogin','serverManagement'])assert.equal(result[key],true,key);
console.log(JSON.stringify(result,null,2));
