'use strict';
const net=require('node:net');
const { parseLanAddress } = require('./lan-address.cjs');
function lanSites(text){return [...text.matchAll(/^\s*(?:https:\/\/)?(\[[0-9a-f:]+\]|(?:\d{1,3}\.){3}\d{1,3})(:\d+)?\s*\{/gmi)].map(m=>parseLanAddress(m[1]+(m[2]||''))).filter(Boolean)}
async function checkLanListeners(candidate,previous=''){
  const existing=new Set(lanSites(previous).map(site=>site.port));
  for(const port of new Set(lanSites(candidate).map(site=>site.port))){
    if(existing.has(port))continue;
    for(const host of ['0.0.0.0','::'])await new Promise((resolve,reject)=>{
      const probe=net.createServer();probe.once('error',error=>{if(host==='::'&&['EAFNOSUPPORT','EADDRNOTAVAIL'].includes(error.code))resolve();else reject(Error(`LAN HTTPS port ${port} is already in use or unavailable. Choose an unused port; existing services were preserved.`))});
      probe.listen({host,port,exclusive:true},()=>probe.close(resolve));
    });
  }
}
module.exports={checkLanListeners};
