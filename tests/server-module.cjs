const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Isolated server-module tests: dependency mocks never reach production services.
module.exports = function loadModule(file, mocks) {
  const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  const requireMock = id => {
    if (id in mocks) return mocks[id];
    if (id.startsWith('@/')) throw new Error(`Unmocked production dependency: ${id}`);
    return require(id);
  };
  vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`, { filename: file })(requireMock, module, module.exports);
  return module.exports;
};
