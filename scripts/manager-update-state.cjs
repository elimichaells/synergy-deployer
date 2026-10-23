// Kept dependency-free so recovery still works while node_modules is being replaced.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ITEMS = ['.next', 'node_modules', 'app', 'components', 'lib', 'scripts', 'db', 'public', 'types', 'docs', 'package.json', 'package-lock.json', 'next.config.js', 'next-env.d.ts', 'tsconfig.json', 'postcss.config.js', 'tailwind.config.js', 'instrumentation.ts', 'middleware.ts', 'release-source.json'];
const TERMINAL = ['succeeded', 'rolled_back', 'failed'];
const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
function inside(root, relative) {
  const target = path.resolve(root, relative), rel = path.relative(path.resolve(root), target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Update path escapes its workspace');
  return target;
}
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
function save(dir, state, phase, message) {
  if (phase) state.phase = phase;
  state.updatedAt = new Date().toISOString();
  if (message) state.events = [...(state.events || []), { at: state.updatedAt, message }].slice(-200);
  atomic(inside(dir, 'state.json'), state);
}
function config(root = process.cwd()) {
  const c = json(path.join(root, '.manager-updater.json'));
  if (path.resolve(c.managerRoot).toLowerCase() !== path.resolve(root).toLowerCase()) throw new Error('Updater registration belongs to another Manager');
  for (const key of ['managerRoot', 'stateRoot', 'nodeExe', 'pm2Home', 'pm2PackageRoot', 'pgDump']) if (!path.isAbsolute(c[key] || '')) throw new Error('Updater registration is incomplete: ' + key);
  if (path.parse(c.managerRoot).root === c.managerRoot || path.parse(c.stateRoot).root === c.stateRoot || c.stateRoot.toLowerCase().startsWith(c.managerRoot.toLowerCase() + path.sep)) throw new Error('Recovery must be outside the application folder');
  return c;
}
function maintenance(root = process.cwd()) { return fs.existsSync(path.join(root, '.manager-maintenance.json')); }
function compare(a, b) {
  if (![a,b].every(v => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v))) throw new Error('Invalid release version');
  const x=a.split('.').map(Number), y=b.split('.').map(Number);
  for (let i=0;i<3;i++) if (x[i] !== y[i]) return Math.sign(x[i]-y[i]);
  return 0;
}
function jobDir(c, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid update identifier');
  return inside(c.stateRoot, 'jobs/' + id);
}
function currentJob(c) {
  try { const id=json(inside(c.stateRoot,'current.json')).id; return { dir:jobDir(c,id), state:json(inside(jobDir(c,id),'state.json')) }; }
  catch (error) { if(error.code==='ENOENT') return null; throw error; }
}
function assertNoLinks(root, names) {
  for (const name of names) {
    const file = inside(root, name);
    if (!fs.existsSync(file)) continue;
    const s = fs.lstatSync(file);
    if (s.isSymbolicLink()) throw new Error('Update paths cannot be symbolic links: ' + name);
    if (s.isDirectory()) assertNoLinks(file, fs.readdirSync(file));
  }
}
function plan(c, dir, state) {
  if (!state.items) {
    state.items = ITEMS.filter(name => fs.existsSync(inside(dir,'stage/'+name))).map(name => ({ name, original:fs.existsSync(inside(c.managerRoot,name)) }));
    save(dir,state,'activating','Activating the verified release');
  }
}
function activate(c, dir, state, fault = () => {}) {
  plan(c,dir,state);
  for (const item of state.items) {
    if (!ITEMS.includes(item.name)) throw new Error('Invalid activation item');
    const target=inside(c.managerRoot,item.name), previous=inside(dir,'previous/'+item.name), staged=inside(dir,'stage/'+item.name);
    fs.mkdirSync(path.dirname(previous),{recursive:true});
    // The intent is durable before either rename. Recovery examines the two locations.
    save(dir,state,undefined,'Replacing ' + item.name);
    if(item.original) fs.renameSync(target,previous);
    fault('after-old',item.name);
    fs.renameSync(staged,target);
    fault('after-new',item.name);
  }
}
function restore(c, dir, state, fault = () => {}) {
  save(dir,state,'rolling_back','Restoring the previous release');
  for (const item of [...(state.items || [])].reverse()) {
    if (!ITEMS.includes(item.name)) throw new Error('Invalid recovery item');
    const target=inside(c.managerRoot,item.name), previous=inside(dir,'previous/'+item.name), failed=inside(dir,'failed/'+item.name);
    // If the original has already been restored, a repeated recovery leaves it alone.
    if (item.original && !fs.existsSync(previous)) continue;
    if (fs.existsSync(target)) { fs.mkdirSync(path.dirname(failed),{recursive:true}); fs.renameSync(target,failed); }
    fault('after-failed',item.name);
    if(item.original) fs.renameSync(previous,target);
    fault('after-restored',item.name);
  }
}
module.exports={ITEMS,TERMINAL,json,inside,atomic,save,config,maintenance,compare,jobDir,currentJob,assertNoLinks,activate,restore};
