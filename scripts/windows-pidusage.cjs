'use strict';
// Embedded in the private PM2 preload. Native Get-Process counters do not
// depend on WMIC or the WMI service, which may be absent/stalled on fresh hosts.
module.exports=function createWindowsPidUsage(){
  const {execFile}=require('node:child_process'),path=require('node:path'),history=new Map(),cache=new Map();let pending=null;
  function usage(pids,options,callback){
    if(typeof options==='function')callback=options;
    if(typeof callback!=='function')return new Promise((resolve,reject)=>usage(pids,{},(error,result)=>error?reject(error):resolve(result)));
    const single=!Array.isArray(pids),ids=[...new Set(single?[pids]:pids)].map(Number);
    if(!ids.length||ids.length>10000||ids.some(id=>!Number.isSafeInteger(id)||id<1||id>2147483647))return queueMicrotask(()=>callback(Error('Invalid process IDs')));
    const now=Date.now();
    if(ids.every(id=>cache.has(id)&&now-cache.get(id).timestamp<1000))return queueMicrotask(()=>{
      const result=Object.fromEntries(ids.filter(id=>cache.get(id).value).map(id=>[id,cache.get(id).value]));
      if(single&&!result[ids[0]]){const missing=Error('No matching pid found');missing.code='ENOENT';callback(missing);}else callback(null,single?result[ids[0]]:result);
    });
    if(pending){pending.then(()=>usage(pids,{},callback));return;}
    let release;pending=new Promise(resolve=>{release=resolve;});
    const script=`$ErrorActionPreference='Stop';$rows=@(foreach($processId in @(${ids.join(',')})){try{$p=[Diagnostics.Process]::GetProcessById($processId);[pscustomobject]@{pid=$p.Id;memory=$p.WorkingSet64;ctime=$p.TotalProcessorTime.TotalMilliseconds;started=$p.StartTime.ToUniversalTime().Ticks}}catch{}finally{if($p){$p.Dispose();$p=$null}}});ConvertTo-Json -InputObject $rows -Compress`;
    const child=execFile(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:5000,maxBuffer:4*1024*1024,encoding:'utf8'},(error,stdout)=>{
      pending=null;release();
      if(error)return callback(Error('Native Windows process counters are unavailable ('+(error.code||error.signal||'execution failed')+(error.killed?', timed out':'')+')'));
      let result;try{
        const now=Date.now(),rows=JSON.parse(stdout.replace(/^\uFEFF/,''));result={};
        for(const row of rows){if(!ids.includes(row.pid))throw Error('Unexpected process counter');const old=history.get(row.pid),elapsed=old?now-old.timestamp:0,cpu=old&&old.started===row.started&&elapsed>0?Math.max(0,(row.ctime-old.ctime)/elapsed*100):0;result[row.pid]={pid:row.pid,ppid:0,memory:row.memory,cpu,ctime:row.ctime,elapsed,timestamp:now};history.set(row.pid,{...row,timestamp:now});}
        for(const [id,old]of history)if(now-old.timestamp>60000)history.delete(id);
        for(const id of ids)cache.set(id,{timestamp:now,value:result[id]||null});
        for(const [id,old]of cache)if(now-old.timestamp>60000)cache.delete(id);
        if(single&&!result[ids[0]]){const missing=Error('No matching pid found');missing.code='ENOENT';throw missing;}
      }catch(parseError){return callback(parseError);}
      callback(null,single?result[ids[0]]:result);
    });
    // Windows PowerShell can wait for EOF when invoked from a detached daemon.
    // There is no input for this fixed, read-only command.
    child.stdin.end();
  }
  usage.clear=()=>{history.clear();cache.clear();};return usage;
};
