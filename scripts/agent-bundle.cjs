'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
// The wire artifact remains a single dependency-free file, including during an
// in-place supervisor update. Source modules can still be tested independently.
async function agentBundle(root = process.cwd()) {
  const source = await fs.readFile(path.join(root, 'scripts/manager-agent.cjs'), 'utf8');
  let resources = await fs.readFile(path.join(root, 'scripts/manager-agent-resources.cjs'), 'utf8');
  const diagnostics=await fs.readFile(path.join(root,'scripts/health-diagnostics.cjs'),'utf8');
  resources=resources.replace("const { readDiagnostics, classifyReadiness } = require('./health-diagnostics.cjs');",`const { readDiagnostics, classifyReadiness } = (()=>{const module={exports:{}};\n${diagnostics}\nreturn module.exports;})();`);
  const marker = "const resources = require('./manager-agent-resources.cjs');";
  if (!source.includes(marker)) throw Error('Agent resource bundle marker missing');
  return source.replace(marker, `const resources = (() => { const module = {exports:{}};\n${resources}\nreturn module.exports; })();`);
}
module.exports = { agentBundle };
