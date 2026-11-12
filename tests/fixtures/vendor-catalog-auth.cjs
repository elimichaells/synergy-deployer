'use strict';
// Hosted runners share anonymous GitHub API limits. Restrict the read-only CI
// credential to catalog requests; never send it to archive hosts or redirects.
if(process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted'&&process.env.GITHUB_TOKEN){
  const original=global.fetch;
  global.fetch=(input,options={})=>{
    if(new URL(String(input)).origin==='https://api.github.com'){
      const headers=new Headers(options.headers);headers.set('Authorization','Bearer '+process.env.GITHUB_TOKEN);
      return original(input,{...options,headers,redirect:'error'});
    }
    return original(input,options);
  };
}
