import { NextResponse } from 'next/server'
import { db, query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { ApiError, jsonError } from '@/lib/api'
import { getSetting } from '@/lib/settings'
import { allocateProjectPorts } from '@/lib/ports'
import { ensureProjectSetupSchema } from '@/lib/project-setup'
import { validateSetupRepository } from '@/lib/project-setup-policy'
import { PROJECT_TYPES } from '@/lib/project-types'
import path from 'path'
import { ensureApplicationGroupsSchema, linkApplicationProjects, componentRole, projectIdentifier } from '@/lib/application-groups'
import { ensureProjectPinsSchema } from '@/lib/project-pins'

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
    await ensureProjectSetupSchema()
    await ensureApplicationGroupsSchema()
    await ensureProjectPinsSchema()

    const { rows } = await query(
      `select p.id, p.name, p.slug, p.repo_url, p.default_branch, p.project_type, p.root_path, p.pm2_name, p.port, p.url, p.auto_deploy, p.github_connection_id, p.is_active, p.environment, p.production_id, p.created_at, p.updated_at,
              s.id as staging_id, p.application_group_id,p.component_role,g.name as application_group_name,gc.name as github_connection_name, gc.account_login as github_account_login, (ps.project_id is not null and ps.completed_at is null) as setup_required,
              (pin.project_id is not null) as pinned
       from projects p
       left join project_setup ps on ps.project_id=p.id
       left join application_groups g on g.id=p.application_group_id
       left join projects s on s.production_id = p.id and s.environment = 'staging'
       left join github_connections gc on gc.id=p.github_connection_id
       left join project_pins pin on pin.project_id=p.id and pin.user_id=$1
       order by (pin.project_id is not null) desc, p.environment asc, p.created_at desc`,
      [user!.id]
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
    if (body.setupDraft === true) {
      try { validateSetupRepository(body.repoUrl || '', body.defaultBranch || 'main') }
      catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 400 }) }
      if (!Object.hasOwn(PROJECT_TYPES, body.projectType)) return NextResponse.json({ error: 'Unsupported project type' }, { status: 400 })
      body.autoDeploy = false
      body.url = null
      await ensureProjectSetupSchema()
    }
    if (body.createStaging !== undefined && typeof body.createStaging !== 'boolean') return NextResponse.json({ error: 'Invalid staging selection' }, { status: 400 })
    const createStaging = body.createStaging === true
    if (body.setupDraft === true && typeof body.createStaging !== 'boolean') return NextResponse.json({ error: 'Choose production only or production with staging' }, { status: 400 })
    if (createStaging) {
      try { validateSetupRepository(body.repoUrl || '', body.stagingBranch || body.defaultBranch || 'main') }
      catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 400 }) }
    }
    await ensureApplicationGroupsSchema()
    const role = componentRole(body.componentRole ?? 'application')
    if (body.relatedProjectId) projectIdentifier(body.relatedProjectId)
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
    if (body.setupDraft === true) {
      if (!path.isAbsolute(rootPath) || path.resolve(rootPath) === path.parse(rootPath).root) return NextResponse.json({ error: 'Choose an absolute application directory, not a drive root' }, { status: 400 })
      const target = path.resolve(rootPath).toLowerCase()
      const existing = await query<{ root_path: string }>('select root_path from projects')
      const roots = [process.cwd(), ...existing.rows.map(project => project.root_path)].map(root => path.resolve(root).toLowerCase())
      if (roots.some(root => target === root || target.startsWith(root + path.sep) || root.startsWith(target + path.sep))) return NextResponse.json({ error: 'Application directory overlaps Manager or another registered application' }, { status: 409 })
    }
    const { port, stagingPort } = body.port
      ? { port: Number(body.port), stagingPort: Number(body.port) + 1000 }
      : await allocateProjectPorts(undefined, undefined, createStaging)
    if (!Number.isInteger(port) || port < 1 || port > 65535 || (createStaging && stagingPort > 65535)) return NextResponse.json({ error: 'Invalid application port' }, { status: 400 })

    const client = await db.connect()
    const { production, staging } = await (async () => {
      try {
        await client.query('begin')
        await client.query("select pg_advisory_xact_lock(hashtext('manager-project-registration'))")
        const conflicts = await client.query('select id from projects where port=any($1::int[]) limit 1', [[port, ...(createStaging ? [stagingPort] : [])]])
        if (conflicts.rows.length) throw new ApiError('An assigned port was just reserved by another application. Retry creation', 409)
        // Create the production project
        const { rows } = await client.query(
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
        const { rows: stagingRows } = !createStaging ? { rows: [] } : await client.query(
          `insert into projects
            (name, slug, repo_url, default_branch, project_type, root_path, install_cmd, build_cmd, deploy_script, start_cmd, pm2_name, port, auto_deploy, github_connection_id, environment, production_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'staging',$15)
          returning id, name, slug, auto_deploy, github_connection_id`,
          [
            `${inferredName} (Staging)`,
            await uniqueValue(`${slug}-staging`, 'slug'),
            body.repoUrl || null,
            body.stagingBranch || body.defaultBranch || 'main',
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
        await client.query('update projects set component_role=$1 where id=$2 or production_id=$2', [role, production.id])
        if (body.relatedProjectId) await linkApplicationProjects(client, production.id, body.relatedProjectId, role)
        if (body.setupDraft === true) {
          await client.query('insert into project_setup (project_id) values ($1)', [production.id])
          if (staging) await client.query('insert into project_setup (project_id) values ($1)', [staging.id])
        }
        await client.query('commit')
        return { production, staging }
      } catch (error) {
        await client.query('rollback')
        throw error
      } finally { client.release() }
    })()
    if (body.autoDeploy === true) {
      try {
        const { ensureGitHubWebhook } = await import('@/lib/github-webhooks')
        await ensureGitHubWebhook(production.id)
        await query(
          'update projects set auto_deploy = true, updated_at = now() where id = any($1::uuid[])',
          [[production.id, ...(staging ? [staging.id] : [])]]
        )
        production.auto_deploy = true
        if (staging) staging.auto_deploy = true
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
