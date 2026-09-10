const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'tests')).filter(file => /\.test\.(ts|cjs)$/.test(file)).map(file => path.join(root, 'tests', file));
const child = spawn(process.execPath, ['--require', path.join(root, 'tests/register.cjs'), '--test', ...files], { cwd: root, stdio: 'inherit', windowsHide: true });
child.on('exit', code => { process.exitCode = code ?? 1; });
