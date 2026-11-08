const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {startWorker}=require('../scripts/manager-update-launch.cjs');
const config={managerRoot:'C:\\Manager',stateRoot:'C:\\ManagerUpdates',nodeExe:'C:\\node.exe',recoveryTask:'Manager Update Recovery ABCDEF123456'};
test('Windows update wake-up delegates ownership to Task Scheduler, never a Manager child worker',()=>{
  const calls=[],child=new EventEmitter();let unreferenced=false;child.unref=()=>unreferenced=true;
  startWorker(config,{platform:'win32',spawn:(...args)=>{calls.push(args);return child}});
  assert.equal(calls.length,1);assert.equal(calls[0][0],'schtasks.exe');assert.deepEqual(calls[0][1],['/Run','/TN',config.recoveryTask]);
  assert.equal(calls[0][2].windowsHide,true);assert.equal(unreferenced,true);
  child.emit('error',Error('Wake-up unavailable'));assert.equal(calls.length,1,'must not fall back to a worker that PM2 can terminate');
});
test('failed or missing Windows wake-up cannot create a worker in the parent process tree',()=>{
  let calls=0;
  assert.doesNotThrow(()=>startWorker(config,{platform:'win32',spawn:()=>{calls++;throw Error('Task Scheduler unavailable')}}));
  for(const recoveryTask of [undefined,'','Unrelated task'])startWorker({...config,recoveryTask},{platform:'win32',spawn:()=>{calls++;throw Error('Unexpected process')}});
  assert.equal(calls,1);
});
test('other platforms keep the detached worker launch with preview disabled',()=>{
  let call;const child=new EventEmitter();child.unref=()=>{};
  startWorker(config,{platform:'linux',spawn:(...args)=>{call=args;return child}});
  assert.equal(call[0],config.nodeExe);assert.match(call[1][0],/manager-update-worker\.cjs$/);assert.equal(call[1][2],'run');
  assert.equal(call[2].detached,true);assert.equal(call[2].env.MANAGER_PREVIEW,'0');
});
