import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ApiError } from './api'
import { audit } from './audit'
import * as S from '@/scripts/manager-update-state.cjs'
import * as P from '@/scripts/manager-update-package.cjs'

const version = process.env.NEXT_PUBLIC_MANAGER_VERSION || '2.21.0'
const assetName = () => `manager-update-${process.platform}-${process.arch}-node${process.versions.node.split('.')[0]}.tar`
function registration() {
  try { return S.config() } catch { throw new ApiError('One-time updater registration is required on this server. Run scripts/install-manager-updater.ps1 as an administrator.', 409) }
}
export async function updateStatus() {
  let c
  try { c = S.config() } catch { return { version, configured: false, assetName: assetName(), job: null, history: [] } }
  const job = S.currentJob(c)
  const history = []
  for (const id of (await fsp.readdir(path.join(c.stateRoot, 'jobs')).catch(() => [])).filter(id => /^[a-f0-9-]{36}$/.test(id))) {
    try { history.push(S.json(path.join(S.jobDir(c,id),'state.json'))) } catch { /* An incomplete preparation has no state yet. */ }
  }
  history.sort((a,b) => b.createdAt.localeCompare(a.createdAt))
  return { version, configured: true, assetName: assetName(), maintenance: S.maintenance(), job: job?.state || null, history: history.slice(0,10), recoveryDirectory: c.stateRoot }
}
export async function latestRelease() {
  const response = await fetch(`https://api.github.com/repos/${P.REPOSITORY}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Synergy-Manager-Updater' }, signal: AbortSignal.timeout(15_000), cache: 'no-store' })
  if (response.status === 404) throw new ApiError('No published release is available yet.',404)
  if (!response.ok) throw new ApiError('GitHub release check failed. Try again later or import an offline package.',502)
  const release = await response.json()
  const next = String(release.tag_name || '').replace(/^v/,'')
  const newer = S.compare(next,version)>0
  const asset = (release.assets || []).find((a: { name: string }) => a.name === assetName())
  const expected = `https://github.com/${P.REPOSITORY}/releases/download/v${next}/${assetName()}`
  if (asset && (asset.browser_download_url !== expected || asset.size > P.MAX_PACKAGE)) throw new ApiError('Unexpected GitHub release asset',502)
  return { version: next, newer, available: !!asset && newer, url: `https://github.com/${P.REPOSITORY}/releases/tag/v${next}`, notes: String(release.body || '').slice(0,20000), publishedAt: release.published_at, asset: asset ? { url: expected, size: asset.size } : null }
}
function startWorker(c: S.UpdateConfig) {
  const worker = path.join(c.stateRoot,'runner/manager-update-worker.cjs')
  const child = spawn(c.nodeExe,[worker,path.join(c.managerRoot,'.manager-updater.json'),'run'],{cwd:c.stateRoot,detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,MANAGER_PREVIEW:'0'}})
  child.on('error', () => { /* The independent recovery task will pick up the queued job. */ })
  child.unref()
}
async function createJob(source: string, userId: string) {
  const c=registration(), existing=S.currentJob(c)
  if(existing && !S.TERMINAL.includes(existing.state.phase)) throw new ApiError('An update or recovery is already in progress.',409)
  // mkdir is an inter-process lock, not an in-memory boolean.
  try { await fsp.mkdir(path.join(c.stateRoot,'prepare.lock')) } catch { throw new ApiError('Another update is being prepared. Wait for it to finish.',409) }
  try {
    const current=S.currentJob(c)
    if(current && !S.TERMINAL.includes(current.state.phase)) throw new ApiError('An update is already active.',409)
    const id=randomUUID(), dir=S.jobDir(c,id)
    await fsp.mkdir(dir,{recursive:true})
    const state: S.UpdateState={id,source,userId,phase:'preparing',fromVersion:version,version:'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),events:[]}
    S.save(dir,state,'preparing','Receiving and verifying update package')
    S.atomic(path.join(c.stateRoot,'current.json'),{id})
    return {c,dir,state}
  } finally { await fsp.rmdir(path.join(c.stateRoot,'prepare.lock')) }
}
export async function prepareUpdate(body: ReadableStream<Uint8Array> | null, source: 'github'|'offline', userId: string) {
  const job=await createJob(source,userId), {c,dir,state}=job
  try {
    let stream=body
    if(source==='github') {
      const latest=await latestRelease()
      if(!latest.available || !latest.asset) throw new ApiError('No newer compatible update package is published yet.',409)
      const response=await fetch(latest.asset.url,{signal:AbortSignal.timeout(20*60_000),redirect:'follow'})
      if(!response.ok)throw new Error('Could not download the GitHub release package')
      stream=response.body
    }
    if(!stream) throw new ApiError('Select an update package first.',400)
    const disk=await fsp.statfs(c.stateRoot)
    if(disk.bavail*disk.bsize<P.MAX_PACKAGE+2*1024**3)throw new ApiError('Keep at least 4 GB free before importing an update.',409)
    const file=path.join(dir,'package.tar'); let bytes=0
    const limiter=new Transform({transform(chunk,_enc,done){bytes+=chunk.length;done(bytes>P.MAX_PACKAGE?new Error('Update package exceeds 2 GB'):null,chunk)}})
    await pipeline(Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0]),limiter,fs.createWriteStream(file,{flags:'wx',mode:0o600}),{signal:AbortSignal.timeout(30*60_000)})
    S.save(dir,state,undefined,'Verifying publisher, release compatibility and package contents')
    const m=await P.verifyAndStage(file,dir,version,path.join(process.cwd(),'scripts/update-trusted-root.json'))
    state.version=m.version; state.commit=m.sourceCommit
    S.atomic(path.join(dir,'inventory.json'),await P.inventory(path.join(dir,'stage')))
    S.save(dir,state,'ready','Verified and ready to install. Manager will briefly restart; hosted applications keep running.')
    await audit(userId,'manager.update.prepare',state.id,{version:m.version,source})
    return state
  } catch(error) {
    S.save(dir,state,'failed','Package preparation failed. '+(error instanceof Error?error.message:'Unknown error'))
    throw new ApiError(error instanceof Error?error.message:'Could not prepare update',400)
  }
}
export async function updateAction(action: unknown,id: unknown,userId: string) {
  const c=registration(),job=S.currentJob(c)
  if(!job || job.state.id!==id) throw new ApiError('The selected update is no longer current. Refresh this page.',409)
  const {dir,state}=job
  if(action==='install' && state.phase==='ready') {
    S.save(dir,state,'queued','Installation requested by an administrator')
  } else if(action==='rollback' && state.phase==='succeeded') {
    state.manualRollback=true;state.recoveryStarted=false
    S.atomic(path.join(c.managerRoot,'.manager-maintenance.json'),{id:state.id,since:new Date().toISOString()})
    S.save(dir,state,'rollback_requested','Rollback requested by an administrator')
  } else if(action==='recover' && state.phase==='recovery_failed') {
    S.save(dir,state,'rollback_requested','Recovery retry requested by an administrator')
  } else if(action==='cancel' && ['ready','preparing'].includes(state.phase)) {
    if(state.phase==='preparing' && Date.now()-Date.parse(state.updatedAt)<35*60_000)throw new ApiError('Wait for package preparation to finish before cancelling.',409)
    S.save(dir,state,'failed','Prepared update cancelled');return state
  } else throw new ApiError('This action is not available for the current update state.',409)
  await audit(userId,'manager.update.'+action,state.id,{version:state.version})
  startWorker(c)
  return state
}
