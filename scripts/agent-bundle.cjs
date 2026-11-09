'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
// The wire artifact remains a single dependency-free file, including during an
// in-place supervisor update. Source modules can still be tested independently.
async function agentBundle(root = process.cwd()) {
  let source = await fs.readFile(path.join(root, 'scripts/manager-agent.cjs'), 'utf8');
  const lan=await fs.readFile(path.join(root,'scripts/lan-address.cjs'),'utf8');
  source=source.replace("const { parseLanAddress, lanCaddyDirectives, assertLanInterface } = require('./lan-address.cjs');",`const { parseLanAddress, lanCaddyDirectives, assertLanInterface } = (()=>{const module={exports:{}};\n${lan}\nreturn module.exports;})();`);
  const listeners=(await fs.readFile(path.join(root,'scripts/lan-listener.cjs'),'utf8')).replace("const { parseLanAddress } = require('./lan-address.cjs');",'');
  source=source.replace("const { checkLanListeners } = require('./lan-listener.cjs');",`const { checkLanListeners } = (()=>{const module={exports:{}};\n${listeners}\nreturn module.exports;})();`);
  let resources = await fs.readFile(path.join(root, 'scripts/manager-agent-resources.cjs'), 'utf8');
  const diagnostics=await fs.readFile(path.join(root,'scripts/health-diagnostics.cjs'),'utf8');
  resources=resources.replace("const { readDiagnostics, classifyReadiness } = require('./health-diagnostics.cjs');",`const { readDiagnostics, classifyReadiness } = (()=>{const module={exports:{}};\n${diagnostics}\nreturn module.exports;})();`);
  const marker = "const resources = require('./manager-agent-resources.cjs');";
  if (!source.includes(marker)) throw Error('Agent resource bundle marker missing');
  return source.replace(marker, `const resources = (() => { const module = {exports:{}};\n${resources}\nreturn module.exports; })();`);
}
module.exports = { agentBundle };
