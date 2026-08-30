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
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator', 'viewer'])

    const { rows } = await query(
      `select p.id, p.name, p.slug, p.repo_url, p.default_branch, p.project_type, p.root_path, p.pm2_name, p.port, p.url, p.auto_deploy, p.github_connection_id, p.is_active, p.environment, p.production_id, p.created_at, p.updated_at,
              s.id as staging_id, gc.name as github_connection_name, gc.account_login as github_account_login
       from projects p
       left join projects s on s.production_id = p.id and s.environment = 'staging'
       left join github_connections gc on gc.id=p.github_connection_id
       order by p.environment asc, p.created_at desc`
    )

    return NextResponse.json(rows)
  } catch (error) {
    return jsonError(error)
  }
}

export async function POST(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])
    const stagingBase = await getSetting('STAGING_PATH')
    const productionBase = await getSetting('PRODUCTION_PATH')

    const body = await request.json().catch(() => null)
    if (!body?.repoUrl && !body?.name) {
      return NextResponse.json({ error: 'Select a GitHub repo or enter a site name' }, { status: 400 })
    }
    if (body.deployScript !== undefined && body.deployScript !== null &&
        (typeof body.deployScript !== 'string' || body.deployScript.length > 50_000)) {
      return NextResponse.json({ error: 'Deployment script must be at most 50,000 characters' }, { status: 400 })
    }
    if (body.autoDeploy !== undefined && typeof body.autoDeploy !== 'boolean') {
      return NextResponse.json({ error: 'Auto deploy must be true or false' }, { status: 400 })
    }
    const githubConnectionId = body.githubConnectionId ? String(body.githubConnectionId) : null
    if (githubConnectionId) {
      const { rows } = await query<{ id: string }>('select id from github_connections where id=$1', [githubConnectionId])
      if (!rows[0]) return NextResponse.json({ error: 'GitHub connection not found' }, { status: 404 })
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
        (name, slug, repo_url, default_branch, project_type, root_path, install_cmd, build_cmd, deploy_script, start_cmd, pm2_name, port, url, auto_deploy, github_connection_id, environment)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'production')
      returning id, name, slug, repo_url, default_branch, project_type, root_path, pm2_name, port, url, auto_deploy, github_connection_id, is_active, environment, created_at, updated_at`,
      [
        inferredName,
        slug,
        body.repoUrl || null,
        body.defaultBranch || 'main',
        body.projectType || 'next',
        rootPath,
        body.installCmd || null,
        body.buildCmd || null,
        body.deployScript?.trim() || null,
        body.startCmd || null,
        pm2Name,
        port,
        body.url || null,
        false,
        githubConnectionId,
      ]
    )

    const production = rows[0]

    // Auto-create staging counterpart
    const { rows: stagingRows } = await query(
      `insert into projects
        (name, slug, repo_url, default_branch, project_type, root_path, install_cmd, build_cmd, deploy_script, start_cmd, pm2_name, port, auto_deploy, github_connection_id, environment, production_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'staging',$15)
      returning id, name, slug, auto_deploy, github_connection_id`,
      [
        `${inferredName} (Staging)`,
        await uniqueValue(`${slug}-staging`, 'slug'),
        body.repoUrl || null,
        body.defaultBranch || 'main',
        body.projectType || 'next',
        path.join(stagingBase, path.basename(rootPath)),
        body.installCmd || null,
        body.buildCmd || null,
        body.deployScript?.trim() || null,
        body.startCmd || null,
        await uniqueValue(`staging-${pm2Name}`, 'pm2_name'),
        stagingPort,
        false,
        githubConnectionId,
        production.id,
      ]
    )

    const staging = stagingRows[0]
    if (body.autoDeploy === true) {
      try {
        const { ensureGitHubWebhook } = await import('@/lib/github-webhooks')
        await ensureGitHubWebhook(production.id)
        await query(
          'update projects set auto_deploy = true, updated_at = now() where id = any($1::uuid[])',
          [[production.id, staging.id]]
        )
        production.auto_deploy = true
        staging.auto_deploy = true
      } catch (error) {
        await query('delete from projects where id = $1 or production_id = $1', [production.id])
        throw error
      }
    }

    // Update Caddy for production if URL/Port available
    if (production.url && production.port) {
      const { updateCaddy } = await import('@/lib/caddy')
      await updateCaddy(production.url, production.port)
    }

    return NextResponse.json({ ...production, staging }, { status: 201 })
  } catch (error) {
    return jsonError(error)
  }
}
