import fs from 'node:fs';
import {createRequire} from 'node:module';
import {DefaultArtifactClient} from '@actions/artifact';
const require=createRequire(import.meta.url),root='C:/ManagerAcceptanceLab';
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const identity=read(root+'/private/identity.json');
if(process.platform!=='win32'||process.env.COMPUTERNAME!==identity.computer)throw Error('Unexpected post-boot machine');
Object.assign(process.env,read(root+'/private/artifact-environment.json'));
let result;
try{result=await require('./verify.cjs').verify('after');}
catch(error){result={status:'failed',error:error.message,runId:identity.runId,computer:identity.computer};}
result.bootBefore=read(root+'/results/install-result.json').bootBefore;
const output=root+'/results/reboot-result.json';fs.writeFileSync(output,JSON.stringify(result,null,2));
const artifact=new DefaultArtifactClient();
for(let attempt=0;attempt<5;attempt++){try{await artifact.uploadArtifact('manager-install-after-reboot',[output],root+'/results',{retentionDays:7});fs.unlinkSync(root+'/private/artifact-environment.json');break;}catch(error){fs.writeFileSync(root+'/private/upload-error.txt',error.message);if(attempt===4)throw error;await new Promise(r=>setTimeout(r,10000));}}
