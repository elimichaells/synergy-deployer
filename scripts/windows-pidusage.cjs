'use strict';
// Embedded in the private PM2 preload. Native Get-Process counters do not
// depend on WMIC or the WMI service, which may be absent/stalled on fresh hosts.
module.exports=function createWindowsPidUsage(){
  const {execFile}=require('node:child_process'),path=require('node:path'),history=new Map();
  function usage(pids,options,callback){
    if(typeof options==='function')callback=options;
    if(typeof callback!=='function')return new Promise((resolve,reject)=>usage(pids,{},(error,result)=>error?reject(error):resolve(result)));
    const single=!Array.isArray(pids),ids=[...new Set(single?[pids]:pids)].map(Number);
    if(!ids.length||ids.length>10000||ids.some(id=>!Number.isSafeInteger(id)||id<1||id>2147483647))return queueMicrotask(()=>callback(Error('Invalid process IDs')));
    const script=`$ErrorActionPreference='Stop';$rows=@(foreach($processId in @(${ids.join(',')})){try{$p=[Diagnostics.Process]::GetProcessById($processId);[pscustomobject]@{pid=$p.Id;memory=$p.WorkingSet64;ctime=$p.TotalProcessorTime.TotalMilliseconds;started=$p.StartTime.ToUniversalTime().Ticks}}catch{}finally{if($p){$p.Dispose();$p=$null}}});ConvertTo-Json -InputObject $rows -Compress`;
    execFile(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:5000,maxBuffer:4*1024*1024,encoding:'utf8'},(error,stdout)=>{
      if(error)return callback(Error('Native Windows process counters are unavailable'));
      let result;try{
        const now=Date.now(),rows=JSON.parse(stdout.replace(/^\uFEFF/,''));result={};
        for(const row of rows){if(!ids.includes(row.pid))throw Error('Unexpected process counter');const old=history.get(row.pid),elapsed=old?now-old.timestamp:0,cpu=old&&old.started===row.started&&elapsed>0?Math.max(0,(row.ctime-old.ctime)/elapsed*100):0;result[row.pid]={pid:row.pid,ppid:0,memory:row.memory,cpu,ctime:row.ctime,elapsed,timestamp:now};history.set(row.pid,{...row,timestamp:now});}
        for(const [id,old]of history)if(now-old.timestamp>60000)history.delete(id);
        if(single&&!result[ids[0]]){const missing=Error('No matching pid found');missing.code='ENOENT';throw missing;}
      }catch(parseError){return callback(parseError);}
      callback(null,single?result[ids[0]]:result);
    });
  }
  usage.clear=()=>history.clear();return usage;
};
