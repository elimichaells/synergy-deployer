'use strict';
const path=require('node:path');
module.exports=async function productionAgentBundle(root=process.cwd()){
  const server=path.join(root,'.next','server');
  // Load the compiled route's modules without invoking a request, signing in,
  // opening a database connection or starting Manager's instrumentation.
  require(path.join(server,'app/api/servers/[[...path]]/route.js'));
  const runtime=require(path.join(server,'webpack-runtime.js'));
  const matches=Object.entries(runtime.m).filter(([,factory])=>factory.toString().includes('Agent resource bundle marker missing'));
  if(matches.length!==1)throw Error('Cannot locate the production agent packager');
  const compiled=runtime(matches[0][0]);
  if(typeof compiled.agentBundle!=='function')throw Error('Production agent packager export changed');
  return compiled.agentBundle(root);
};
