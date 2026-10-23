// TUF validates the downloaded trust material against the library's embedded root.
// Never accept a trust root supplied inside an uploaded update package.
const fs=require('node:fs/promises');
const path=require('node:path');
const {getTrustedRoot}=require('@sigstore/tuf');
const {TrustedRoot}=require('@sigstore/protobuf-specs');
async function refresh(file) {
  const root=await getTrustedRoot();
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,JSON.stringify(TrustedRoot.toJSON(root),null,2));
}
if(require.main===module)refresh(process.argv[2]||path.join(__dirname,'update-trusted-root.json')).catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={refresh};
