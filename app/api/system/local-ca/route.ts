import { NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { X509Certificate } from 'node:crypto'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'

export async function GET() {
  try {
    requireRole(await getSessionFromCookie(), ['admin','operator','viewer'])
    const download = (pem: string) => {
      if(pem.includes('PRIVATE KEY'))throw new Error('Invalid public CA certificate')
      const certificate=new X509Certificate(pem)
      if(!certificate.ca)throw new Error('Certificate is not a CA')
      return new NextResponse(certificate.toString(),{headers:{'Content-Type':'application/x-pem-file','Content-Disposition':'attachment; filename="manager-lan-root-ca.crt"','Cache-Control':'no-store'}})
    }
    // Prefer the running proxy's CA, including installations with custom storage.
    const admin=process.env.CADDY_ADMIN || '127.0.0.1:2019'
    if(/^(?:http:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/.test(admin)) {
      try {
        const origin=`${admin.startsWith('http://')?'':'http://'}${admin}`
        const response=await fetch(`${origin}/pki/ca/local`,{headers:{Origin:origin},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(3000)})
        if(response.status===404)throw new ApiError('The running proxy has no local CA yet. Start its first LAN route before downloading the certificate.',409)
        if(response.ok){
          try {const ca=await response.json();if(typeof ca.root_certificate!=='string')throw Error('Missing public certificate');return download(ca.root_certificate)}
          catch {throw new ApiError('The running proxy did not return a valid public CA certificate.',409)}
        }
      } catch (error) {
        if(error instanceof ApiError)throw error
        console.warn('[Caddy] Could not read the active public CA:',(error as Error).message)
      }
    }
    const candidates = [
      process.env.CADDY_CA_CERTIFICATE,
      process.env.XDG_DATA_HOME && path.join(process.env.XDG_DATA_HOME,'caddy/pki/authorities/local/root.crt'),
      path.join(process.env.ProgramData || 'C:\\ProgramData','Manager/caddy-data/caddy/pki/authorities/local/root.crt'),
      process.env.APPDATA && path.join(process.env.APPDATA,'Caddy/pki/authorities/local/root.crt'),
    ].filter((file):file is string=>!!file)
    for (const file of candidates) {
      const pem=await readFile(file,'utf8').catch(()=>null)
      if(!pem||pem.includes('PRIVATE KEY'))continue
      try { return download(pem) } catch { /* Ignore malformed or non-CA files. */ }
    }
    throw new ApiError('The local CA is not available yet. Start the first LAN route, then download its public certificate.',409)
  } catch(error) { return jsonError(error) }
}
