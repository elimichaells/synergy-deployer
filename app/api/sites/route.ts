import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { getSetting } from '@/lib/settings'
import { allocateProjectPorts } from '@/lib/ports'
import path from 'path'

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
}

function stripGitSuffix(input: string) {
  return input.replace(/\.git$/, '')
}

function inferRepoName(repoUrl: string) {
  const clean = stripGitSuffix(repoUrl).replace(/\/$/, '')
  return clean.split(/[\\/]/).pop() || ''
}

async function uniqueValue(base: string, column: 'slug' | 'pm2_name') {
  let candidate = base
  let index = 2
  while (true) {
    const { rows } = await query<{ id: string }>(`select id from projects where ${column} = $1 limit 1`, [candidate])
    if (rows.length === 0) return candidate
    candidate = `${base}-${index}`
    index++
  }
}

export async function GET() {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])

    const { rows } = await query(
      `select p.id, p.name, p.slug, p.repo_url, p.default_branch, p.project_type, p.root_path, p.pm2_name, p.port, p.url, p.is_active, p.environment, p.production_id, p.created_at, p.updated_at,
              s.id as staging_id
       from projects p
       left join projects s on s.production_id = p.id and s.environment = 'staging'
       order by p.environment asc, p.created_at desc`
    )

    return NextResponse.json(rows)
  } catch (error) {
    return jsonError(error)
  }
}

export async function POST(request: Request) {
  try {
    const user = getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    const stagingBase = await getSetting('STAGING_PATH')
    const productionBase = await getSetting('PRODUCTION_PATH')

    const body = await request.json().catch(() => null)
    if (!body?.repoUrl && !body?.name) {
      return NextResponse.json({ error: 'Select a GitHub repo or enter a site name' }, { status: 400 })
    }

    const inferredName = body.name || inferRepoName(body.repoUrl || '')
    if (!inferredName) {
      return NextResponse.json({ error: 'Could not infer site name' }, { status: 400 })
    }

    const baseSlug = body.slug ? slugify(body.slug) : slugify(inferredName)
    const slug = await uniqueValue(baseSlug, 'slug')
    const pm2Name = await uniqueValue(slugify(body.pm2Name || inferredName), 'pm2_name')
    const folderName = body.folderName ? slugify(body.folderName) : slug
    const rootPath = body.rootPath || path.join(productionBase, folderName)
    const { port, stagingPort } = body.port
      ? { port: Number(body.port), stagingPort: Number(body.port) + 1000 }
      : await allocateProjectPorts()

    // Create the production project
    const { rows } = await query(
      `insert into projects
        (name, slug, repo_url, default_branch, project_type, root_path, install_cmd, build_cmd, start_cmd, pm2_name, port, url, environment)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'production')
      returning id, name, slug, repo_url, default_branch, project_type, root_path, pm2_name, port, url, is_active, environment, created_at, updated_at`,
      [
        inferredName,
        slug,
        body.repoUrl || null,
        body.defaultBranch || 'main',
        body.projectType || 'next',
        rootPath,
        body.installCmd || null,
        body.buildCmd || null,
        body.startCmd || null,
        pm2Name,
        port,
        body.url || null,
      ]
    )

    const production = rows[0]

    // Auto-create staging counterpart
    const { rows: stagingRows } = await query(
      `insert into projects
        (name, slug, repo_url, default_branch, project_type, root_path, install_cmd, build_cmd, start_cmd, pm2_name, port, environment, production_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'staging',$12)
      returning id, name, slug`,
      [
        `${inferredName} (Staging)`,
        await uniqueValue(`${slug}-staging`, 'slug'),
        body.repoUrl || null,
        body.defaultBranch || 'main',
        body.projectType || 'next',
        path.join(stagingBase, path.basename(rootPath)),
        body.installCmd || null,
        body.buildCmd || null,
        body.startCmd || null,
        await uniqueValue(`staging-${pm2Name}`, 'pm2_name'),
        stagingPort,
        production.id,
      ]
    )

    // Update Caddy for production if URL/Port available
    if (production.url && production.port) {
      const { updateCaddy } = await import('@/lib/caddy')
      await updateCaddy(production.url, production.port)
    }

    return NextResponse.json({ ...production, staging: stagingRows[0] }, { status: 201 })
  } catch (error) {
    return jsonError(error)
  }
}
