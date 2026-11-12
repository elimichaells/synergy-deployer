const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const agent = require('../scripts/manager-agent.cjs');

test('Windows Composer batch launchers work from reused paths with spaces and shell characters', {skip:process.platform !== 'win32'}, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'manager-composer-check-'));
  try {
    const directory = path.join(root,'tools & (copy) %literal% !');
    await fs.mkdir(directory);
    for (const extension of ['bat','cmd']) {
      const composer = path.join(directory,'composer.'+extension);
      await fs.writeFile(composer,'@echo off\r\nif not "%~1"=="--version" exit /b 9\r\necho PHP version 8.3.6\r\necho Composer version 2.8.12\r\n');
      await fs.writeFile(path.join(root,'tool-paths.json'),JSON.stringify({composer}));
      await agent.loadToolPaths(root);
      assert.equal(await agent.toolVersion('composer'),'Composer version 2.8.12');
    }
  } finally {
    await fs.writeFile(path.join(root,'tool-paths.json'),'{}');
    await agent.loadToolPaths(root);
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)) throw Error('Unexpected fixture directory');
    await fs.rm(root,{recursive:true,force:true});
  }
});
