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
    const candidates = [
      process.env.CADDY_CA_CERTIFICATE,
      process.env.XDG_DATA_HOME && path.join(process.env.XDG_DATA_HOME,'caddy/pki/authorities/local/root.crt'),
      path.join(process.env.ProgramData || 'C:\\ProgramData','Manager/caddy-data/caddy/pki/authorities/local/root.crt'),
      process.env.APPDATA && path.join(process.env.APPDATA,'Caddy/pki/authorities/local/root.crt'),
    ].filter((file):file is string=>!!file)
    for (const file of candidates) {
      const pem=await readFile(file,'utf8').catch(()=>null)
      if(!pem||pem.includes('PRIVATE KEY'))continue
      const certificate=new X509Certificate(pem)
      if(!certificate.ca)continue
      return new NextResponse(certificate.toString(),{headers:{'Content-Type':'application/x-pem-file','Content-Disposition':'attachment; filename="manager-lan-root-ca.crt"','Cache-Control':'no-store'}})
    }
    throw new ApiError('The local CA is not available yet. Start the first LAN route, then download its public certificate.',409)
  } catch(error) { return jsonError(error) }
}
