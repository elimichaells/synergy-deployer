const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {pipeline} = require('node:stream/promises');
const tar = require('tar');
const {ITEMS,compare,inside,assertNoLinks} = require('./manager-update-state.cjs');
const REPOSITORY='elimichaells/synergy-deployer';
const MAX_PACKAGE=2*1024**3;
async function sha(file) {
  const hash=crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function safeEntry(name, entry, outer=false) {
  const clean=name.replace(/\/$/,'');
  if (!clean || /[\\:\x00-\x1f]/.test(clean) || clean.startsWith('/') || clean.split('/').some(x=>!x || x==='.' || x==='..' || /[. ]$/.test(x) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x))) throw new Error('Unsafe path in update package');
  if (!['File','Directory'].includes(entry.type)) throw new Error('Links and special files are forbidden in update packages');
  if (outer ? !['manifest.json','provenance.json','payload.tar.gz'].includes(clean) : !ITEMS.includes(clean.split('/')[0])) throw new Error('Unexpected file in update package: '+clean);
  return clean;
}
async function extract(file, dest, outer=false) {
  let bytes=0, count=0; const seen=new Set();
  const scanner=tar.t({strict:true,maxMetaEntrySize:1024*1024,onReadEntry:e=>{try{
    const name=safeEntry(e.path,e,outer).toLowerCase();
    if(seen.has(name)) throw new Error('Duplicate path in update package');
    seen.add(name); bytes+=e.size; count++;
    if(bytes>(outer?MAX_PACKAGE:8*1024**3) || count>150000 || (outer && e.path!=='payload.tar.gz' && e.size>2*1024**2)) throw new Error('Update package exceeds extraction limits');
  }catch(error){scanner.abort(error)}}});
  await pipeline(fs.createReadStream(file),scanner);
  const disk=await fsp.statfs(path.dirname(dest));
  if(disk.bavail*disk.bsize<bytes+1024**3) throw new Error('Not enough free disk space to stage this update');
  await fsp.mkdir(dest,{recursive:true});
  await tar.x({file,cwd:dest,strict:true,noChmod:true,noMtime:true,filter:(name,e)=>!!safeEntry(name,e,outer)});
  return {bytes,count};
}
function manifestCheck(m,current,platform=process.platform,arch=process.arch,major=Number(process.versions.node.split('.')[0]),options={}) {
  if(m.format!==1 || m.repository!==REPOSITORY || m.schemaCompatibility!=='additive' || !/^[a-f0-9]{64}$/.test(m.payloadSha256) || !/^[a-f0-9]{40}$/.test(m.sourceCommit)) throw new Error('Unsupported update manifest');
  const bootstrap=options.bootstrap && m.version==='2.21.0' && m.bootstrapMinimumVersion==='2.17.0';
  const sameLocal=bootstrap && options.localBootstrap && compare(m.version,current)===0;
  if(compare(m.version,current)<=0 && !sameLocal) throw new Error('This package is not newer than the installed release');
  const minimum=bootstrap?m.bootstrapMinimumVersion:m.minimumVersion;
  if(compare(current,minimum)<0) throw new Error('Install the required bridge release first: '+minimum);
  if(m.platform!==platform || m.arch!==arch || m.nodeMajor!==major) throw new Error('This package does not match this server’s operating system, architecture and Node.js major version');
  if(!Number.isSafeInteger(m.payloadBytes) || m.payloadBytes<=0 || m.payloadBytes>MAX_PACKAGE) throw new Error('Invalid payload size');
}
function verifyProvenance(manifestBytes, provenance, root) {
  const {bundleFromJSON}=require('@sigstore/bundle');
  const {TrustedRoot}=require('@sigstore/protobuf-specs');
  const {Verifier,toSignedEntity,toTrustMaterial}=require('@sigstore/verify');
  const m=JSON.parse(manifestBytes.toString('utf8'));
  const bundle=bundleFromJSON(provenance);
  const identity=`https://github.com/${REPOSITORY}/.github/workflows/manager-release.yml@refs/tags/v${m.version}`;
  new Verifier(toTrustMaterial(TrustedRoot.fromJSON(root))).verify(toSignedEntity(bundle),{
    subjectAlternativeName:'^'+identity.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$', extensions:{issuer:'https://token.actions.githubusercontent.com'}
  });
  if(bundle.content.$case!=='dsseEnvelope') throw new Error('A build provenance attestation is required');
  const statement=JSON.parse(bundle.content.dsseEnvelope.payload.toString('utf8'));
  if(statement._type!=='https://in-toto.io/Statement/v1' || statement.predicateType!=='https://slsa.dev/provenance/v1' || !statement.subject?.some(s=>s.digest?.sha256===crypto.createHash('sha256').update(manifestBytes).digest('hex'))) throw new Error('Attestation does not cover this update manifest');
  const workflow=statement.predicate?.buildDefinition?.externalParameters?.workflow;
  if(workflow?.repository!==`https://github.com/${REPOSITORY}` || workflow?.ref!==`refs/tags/v${m.version}` || workflow?.path!=='.github/workflows/manager-release.yml') throw new Error('Unexpected release workflow');
  const source=statement.predicate?.buildDefinition?.resolvedDependencies || [];
  if(!source.some(d=>d.digest?.gitCommit===m.sourceCommit)) throw new Error('Release source commit does not match the attestation');
}
async function verifyAndStage(file,dir,current,trustFile,options={}) {
  await extract(file,inside(dir,'envelope'),true);
  const envelope=inside(dir,'envelope');
  const manifestBytes=await fsp.readFile(inside(envelope,'manifest.json'));
  const m=JSON.parse(manifestBytes); manifestCheck(m,current,process.platform,process.arch,Number(process.versions.node.split('.')[0]),options);
  verifyProvenance(manifestBytes,JSON.parse(await fsp.readFile(inside(envelope,'provenance.json'),'utf8')),JSON.parse(await fsp.readFile(trustFile,'utf8')));
  const payload=inside(envelope,'payload.tar.gz');
  if((await fsp.stat(payload)).size!==m.payloadBytes || await sha(payload)!==m.payloadSha256) throw new Error('Update payload integrity check failed');
  await extract(payload,inside(dir,'stage'));
  await validateStage(inside(dir,'stage'),m);
  return m;
}
async function validateStage(stage,m) {
  assertNoLinks(stage,fs.readdirSync(stage));
  const p=JSON.parse(await fsp.readFile(inside(stage,'package.json'),'utf8'));
  const receipt=JSON.parse(await fsp.readFile(inside(stage,'release-source.json'),'utf8'));
  if(p.version!==m.version || receipt.version!==m.version || receipt.sourceCommit!==m.sourceCommit) throw new Error('Package release identity is inconsistent');
  for(const name of ['.next/BUILD_ID','node_modules/next/dist/bin/next','scripts/manager-update-worker.cjs','scripts/manager-agent.cjs']) await fsp.access(inside(stage,name));
}
async function inventory(root) {
  const files={},pending=[];
  async function walk(dir,prefix='') {
    for(const entry of await fsp.readdir(dir,{withFileTypes:true})) {
      const rel=prefix+entry.name, file=inside(root,rel);
      if(entry.isSymbolicLink()) throw new Error('Symbolic link in staged release');
      if(entry.isDirectory()) await walk(file,rel+'/');
      else if(entry.isFile()) pending.push([rel,file]);
      else throw new Error('Special file in staged release');
    }
  }
  await walk(root);
  let next=0;
  await Promise.all(Array.from({length:8},async()=>{while(next<pending.length){const [rel,file]=pending[next++];files[rel]=await sha(file)}}));
  return files;
}
module.exports={REPOSITORY,MAX_PACKAGE,sha,safeEntry,extract,manifestCheck,verifyProvenance,verifyAndStage,validateStage,inventory};
