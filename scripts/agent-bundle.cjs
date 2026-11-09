'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
// The wire artifact remains a single dependency-free file, including during an
// in-place supervisor update. Source modules can still be tested independently.
async function agentBundle(root = process.cwd()) {
  let source = await fs.readFile(path.join(root, 'scripts/manager-agent.cjs'), 'utf8');
  source=source.replace("const createWindowsPidUsage = require('./windows-pidusage.cjs');",`const createWindowsPidUsage = ${require('./windows-pidusage.cjs').toString()};`);
  const consolePolicy=await fs.readFile(path.join(root,'scripts/console-policy.cjs'),'utf8');
  source=source.replace("const consolePolicy = require('./console-policy.cjs');",`const consolePolicy=(()=>{const module={exports:{}};\n${consolePolicy}\nreturn module.exports;})();`);
  const releaseData=await fs.readFile(path.join(root,'scripts/remote-release-data.cjs'),'utf8');
  source=source.replace("const releaseData = require('./remote-release-data.cjs');",`const releaseData = (()=>{const module={exports:{}};\n${releaseData}\nreturn module.exports;})();`);
  const audit=await fs.readFile(path.join(root,'scripts/dependency-audit.cjs'),'utf8');
  source=source.replace("const { assertAuditPassed, formatAuditFindings } = require('./dependency-audit.cjs');",`const { assertAuditPassed, formatAuditFindings } = (()=>{const module={exports:{}};const exports=module.exports;\n${audit}\nreturn module.exports;})();`);
  const lan=await fs.readFile(path.join(root,'scripts/lan-address.cjs'),'utf8');
  source=source.replace("const { parseLanAddress, lanCaddyDirectives, lanProxyHeaders, assertLanInterface } = require('./lan-address.cjs');",`const { parseLanAddress, lanCaddyDirectives, lanProxyHeaders, assertLanInterface } = (()=>{const module={exports:{}};\n${lan}\nreturn module.exports;})();`);
  const listeners=(await fs.readFile(path.join(root,'scripts/lan-listener.cjs'),'utf8')).replace("const { parseLanAddress } = require('./lan-address.cjs');",'');
  source=source.replace("const { checkLanListeners } = require('./lan-listener.cjs');",`const { checkLanListeners } = (()=>{const module={exports:{}};\n${listeners}\nreturn module.exports;})();`);
  let resources = await fs.readFile(path.join(root, 'scripts/manager-agent-resources.cjs'), 'utf8');
  const postgresArchive=await require('./agent-postgres-runtime.cjs').packagePostgresRuntime(root);
  const loader=await fs.readFile(path.join(root,'scripts/agent-runtime-loader.cjs'),'utf8');
  let storage=await fs.readFile(path.join(root,'scripts/remote-storage-agent.cjs'),'utf8');
  const providers=await fs.readFile(path.join(root,'scripts/remote-storage-providers.cjs'),'utf8');
  storage=storage.replace("const providers=require('./remote-storage-providers.cjs');",`const providers=(()=>{const module={exports:{}};\n${providers}\nreturn module.exports;})();`);
  storage=storage.replace("async function driver(_root,_helpers,name,_archive){switch(name){case 'mysql2/promise':return require('mysql2/promise');case 'mssql':return require('mssql');case 'mongodb':return require('mongodb');case 'redis':return require('redis');default:throw Error('Unknown database driver');}}","async function driver(root,helpers,name,archive){return loadPostgresRuntime(root,archive,helpers,name);}");
  storage=storage.replace("async function postgres(_root,_helpers){return require('pg');}",`const {loadPostgresRuntime}=(()=>{const module={exports:{}};\n${loader}\nreturn module.exports;})();\nasync function postgres(root,helpers){return loadPostgresRuntime(root,${JSON.stringify(postgresArchive)},helpers);}`);
  resources=resources.replace("const storage = require('./remote-storage-agent.cjs');",`const storage=(()=>{const module={exports:{}};\n${storage}\nreturn module.exports;})();`);
  let storageSwitch=await fs.readFile(path.join(root,'scripts/remote-storage-switch.cjs'),'utf8');
  for(const [binding,file] of [['env','database-env-rewrite'],['ownership','postgres-ownership']]){
    const code=await fs.readFile(path.join(root,`scripts/${file}.cjs`),'utf8');
    storageSwitch=storageSwitch.replace(`const ${binding}=require('./${file}.cjs');`,`const ${binding}=(()=>{const module={exports:{}};const exports=module.exports;\n${code}\nreturn module.exports;})();`);
  }
  resources=resources.replace("const storageSwitch = require('./remote-storage-switch.cjs');",`const storageSwitch=(()=>{const module={exports:{}};\n${storageSwitch}\nreturn module.exports;})();`);
  const ownershipCode=await fs.readFile(path.join(root,'scripts/postgres-ownership.cjs'),'utf8');
  const ownershipFactory=`(()=>{const module={exports:{}};const exports=module.exports;\n${ownershipCode}\nreturn module.exports;})()`;
  const copyCode=(await fs.readFile(path.join(root,'scripts/postgres-copy.cjs'),'utf8')).replace("require('./postgres-ownership.cjs')",ownershipFactory);
  const moveCode=(await fs.readFile(path.join(root,'scripts/remote-storage-move.cjs'),'utf8')).replace("require('./remote-storage-switch.cjs')",'storageSwitch').replace("require('./postgres-ownership.cjs')",ownershipFactory).replace("require('./postgres-copy.cjs')",`(()=>{const module={exports:{}};\n${copyCode}\nreturn module.exports;})()`);
  resources=resources.replace("const storageMove = require('./remote-storage-move.cjs');",`const storageMove=(()=>{const module={exports:{}};\n${moveCode}\nreturn module.exports;})();`);
  const migrationEngine=await fs.readFile(path.join(root,'scripts/relational-migration.cjs'),'utf8');
  const migrationCode=(await fs.readFile(path.join(root,'scripts/remote-storage-migration.cjs'),'utf8')).replace("require('./relational-migration.cjs')",`(()=>{const module={exports:{}};\n${migrationEngine}\nreturn module.exports;})()`);
  resources=resources.replace("const storageMigration = require('./remote-storage-migration.cjs');",`const storageMigration=(()=>{const module={exports:{}};\n${migrationCode}\nreturn module.exports;})();`);
  resources=resources.replace("require('./manager-agent-windows-memory.cjs')",JSON.stringify(require('./manager-agent-windows-memory.cjs')));
  const diagnostics=await fs.readFile(path.join(root,'scripts/health-diagnostics.cjs'),'utf8');
  const health=(await fs.readFile(path.join(root,'scripts/http-health.cjs'),'utf8')).replace("const { readDiagnostics } = require('./health-diagnostics.cjs');",`const { readDiagnostics } = (()=>{const module={exports:{}};\n${diagnostics}\nreturn module.exports;})();`);
  source=source.replace("const { probeHttp, validateHealthProfile } = require('./http-health.cjs');",`const { probeHttp, validateHealthProfile } = (()=>{const module={exports:{}};\n${health}\nreturn module.exports;})();`);
  resources=resources.replace("const { probeHttp, validateHealthProfile } = require('./http-health.cjs');",`const { probeHttp, validateHealthProfile } = (()=>{const module={exports:{}};\n${health}\nreturn module.exports;})();`);
  resources=resources.replace("const { readDiagnostics, classifyReadiness } = require('./health-diagnostics.cjs');",`const { readDiagnostics, classifyReadiness } = (()=>{const module={exports:{}};\n${diagnostics}\nreturn module.exports;})();`);
  const marker = "const resources = require('./manager-agent-resources.cjs');";
  if (!source.includes(marker)) throw Error('Agent resource bundle marker missing');
  return source.replace(marker, `const resources = (() => { const module = {exports:{}};\n${resources}\nreturn module.exports; })();`);
}
module.exports = { agentBundle };
