'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),load=require('./server-module.cjs');
test('vendor archive lookup retries incomplete publication without changing tag or architecture',async()=>{
  const downloads=load('lib/service-upgrade-downloads.ts',{'./api':{ApiError:Error},'./server-ssh':{installerDownloads:async()=>({node:{}})}}),original=global.fetch,requests=[];
  global.fetch=async url=>{requests.push(String(url));return Response.json({assets:requests.length===1?[]:[{name:'sling_windows_amd64.tar.gz',browser_download_url:'https://github.com/slingdata-io/sling-cli/releases/download/v1.6.7/sling_windows_amd64.tar.gz',digest:'sha256:'+'a'.repeat(64)}]})};
  try{const result=await downloads.serviceUpgradeDownloads('sling','1.6.6','1.6.7','win32','x64');assert.equal(requests.length,2);assert.equal(new Set(requests).size,1);assert.match(requests[0],/tags\/v1.6.7$/);assert.equal(result.update.sha256,'a'.repeat(64));assert.equal(result.update.executable,'sling.exe')}finally{global.fetch=original}
});
test('ambiguous vendor assets are rejected before downloading executable code',async()=>{
  const downloads=load('lib/service-upgrade-downloads.ts',{'./api':{ApiError:Error},'./server-ssh':{installerDownloads:async()=>({node:{}})}}),original=global.fetch;let requests=0;
  global.fetch=async()=>{requests++;return Response.json({assets:[{name:'sqlcmd-windows-amd64.zip'},{name:'sqlcmd-windows-amd64.zip'}]})};
  try{await assert.rejects(downloads.serviceUpgradeDownloads('sqlserver','1.9.0','1.10.0','win32','x64'),/No unique official archive/);assert.equal(requests,1)}finally{global.fetch=original}
});
