'use strict';
const services={phpmyadmin:{kind:'browser'},caddy:{kind:'proxy'},postgresql:{kind:'database',series:1},mysql:{kind:'database',series:2},mariadb:{kind:'database',series:2},mongodb:{kind:'database',series:2},redis:{kind:'database',series:2},sling:{kind:'tool'},composer:{kind:'tool'},sqlserver:{kind:'tool'},angular:{kind:'npm'},pm2:{kind:'npm'},git:{kind:'tool'}};
function supports(service,platform){return !!services[service]&&(['postgresql','mysql','mariadb','git'].includes(service)?platform==='win32':service==='redis'?platform==='linux':['win32','linux'].includes(platform));}
function version(value){value=String(value||'');const result=/MariaDB/i.test(value)?value.match(/(?:Distrib\s+)?(\d+\.\d+\.\d+)(?:-[^\s]*)?-MariaDB/i)?.[1]||value.match(/Distrib\s+(\d+\.\d+\.\d+)/i)?.[1]||value.match(/\d+\.\d+(?:\.\d+)?/)?.[0]:value.match(/\d+\.\d+(?:\.\d+)?/)?.[0];if(!result)throw Error('Inspect the installed version before upgrading');return result;}
function validate(service,current,next,platform){
  if(!supports(service,platform))throw Error('This installation needs its operating-system package maintenance workflow');
  if(!/^\d+\.\d+(?:\.\d+)?$/.test(next))throw Error('Choose a stable vendor release');
  current=version(current);if(next.localeCompare(current,undefined,{numeric:true})<=0)throw Error('The update must be newer than the installed version');
  const series=services[service].series;if(series&&current.split('.').slice(0,series).join('.')!==next.split('.').slice(0,series).join('.'))throw Error('Database updates must stay on the installed release series. Major migrations require a separate database migration.');
  return {currentVersion:current,version:next,kind:services[service].kind};
}
module.exports={services,supports,validate,version};
