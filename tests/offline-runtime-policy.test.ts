import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { offlineCommand, offlinePackage, offlineServiceReceipt } from '../lib/offline-runtimes'

test('offline dashboard commands never fall back to package managers or online catalogs', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'manager-offline-runtime-'))
  const previous=process.env.PROGRAMDATA
  process.env.PROGRAMDATA=root
  try{
    const bundle=path.join(root,'Manager','offline-services');fs.mkdirSync(bundle,{recursive:true})
    const artifacts=['mysql','mariadb','mongodb','sqlserver','phpmyadmin'].map(id=>({id,file:id+'.zip',version:'1'}))
    fs.writeFileSync(path.join(bundle,'services.json'),JSON.stringify({artifacts}))
    for(const item of artifacts){fs.writeFileSync(path.join(bundle,item.file),'fixture');const cmd=offlineCommand(item.id,'install');assert.equal(typeof cmd,'object');assert.ok(typeof cmd==='object'&&cmd.args.includes('Install'));assert.ok(!JSON.stringify(cmd).includes('choco'));}
    for(const action of ['update','install-version','unexpected'])assert.throws(()=>offlineCommand('mysql',action),/upgrades are disabled/)
    assert.throws(()=>offlineCommand('redis','install'),/existing Redis/)
    assert.throws(()=>offlineCommand('angular','install'),/not in the offline/)
    fs.unlinkSync(path.join(bundle,'mysql.zip'));assert.equal(offlinePackage('mysql'),null);assert.throws(()=>offlineCommand('mysql','install'),/package is missing/)
    assert.equal(offlineServiceReceipt('mysql'),null)
    assert.throws(()=>offlineCommand('../mysql','install'),/Unsupported|not in the offline/)
  }finally{if(previous===undefined)delete process.env.PROGRAMDATA;else process.env.PROGRAMDATA=previous;fs.rmSync(root,{recursive:true,force:true})}
})
