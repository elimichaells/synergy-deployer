// Invoked by the HTTPS integration test in a new process with an empty Windows profile.
const fs=require('node:fs'),path=require('node:path');
const load=require('../server-module.cjs');
const fixture=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const policy=require('../../lib/git-provider-policy.ts'),api=require('../../lib/git-provider-api.ts');
const paths={...require('../../lib/paths.ts'),managerDataRoot:()=>fixture.stateRoot};
const connection=load('lib/github-connections.ts',{'@/lib/api':{ApiError:Error},'@/lib/db':{query:async sql=>({rows:sql.startsWith('select token_ciphertext')?[{token_ciphertext:fixture.ciphertext}]:[]})},'@/lib/settings':{},'./git-provider-policy':policy,'./git-provider-api':api});
const access=load('lib/git-access.ts',{'./github-connections':{getGitConnection:async()=>fixture.host,getGitHubConnectionToken:()=>connection.getGitHubConnectionToken('fixture',false)},'./git-provider-policy':policy,'./paths':paths});
const {runCommand}=load('lib/exec.ts',{'./paths':paths});
(async()=>{
 const auth=await access.prepareGitAccess({repo_url:fixture.repo,github_connection_id:'fixture'});
 const env=access.gitEnvironment(auth.config,fixture.checkout);
 const command={file:access.installedGit(fixture.checkout),args:fixture.operation==='clone'?['clone','--branch','main','--',fixture.repo,fixture.checkout]:['fetch',fixture.repo,'+refs/heads/main:refs/remotes/origin/main']};
 const result=await runCommand(command,fixture.operation==='clone'?path.dirname(fixture.checkout):fixture.checkout,30000,undefined,env,false,{redact:auth.secrets});
 if(result.code)throw new Error(result.output);
 if(fixture.operation==='fetch'){
  const merged=await runCommand({file:command.file,args:['merge','--ff-only','origin/main']},fixture.checkout,30000,undefined,access.gitEnvironment([],fixture.checkout),false);
  if(merged.code)throw new Error(merged.output);
 }
 if(fixture.push){
  fs.writeFileSync(path.join(fixture.checkout,'after-reboot.txt'),'created after restart');
  for(const args of [['add','after-reboot.txt'],['commit','-m','after restart'],['push',fixture.repo,'main']]){
   const result=await runCommand({file:command.file,args},fixture.checkout,30000,undefined,access.gitEnvironment(args[0]==='push'?auth.config:[],fixture.checkout),false,{redact:auth.secrets});
   if(result.code)throw new Error(result.output);
  }
 }
 console.log('Git operation passed with a fresh profile');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
