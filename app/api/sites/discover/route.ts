import { NextResponse } from 'next/server'
import { readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { query } from '@/lib/db'
import { getSessionFromCookie } from '@/lib/auth'
import { requireRole } from '@/lib/rbac'
import { jsonError } from '@/lib/api'
import { runCommand } from '@/lib/exec'
import { getSetting } from '@/lib/settings'

interface CandidateProject {
  id?: string
  name: string
  slug: string
  repoUrl: string | null
  rootPath: string
  pm2Name: string
  defaultBranch: string
  projectType: string
}

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
}

function detectProjectType(rootPath: string) {
  if (existsSync(path.join(rootPath, 'artisan')) || existsSync(path.join(rootPath, 'composer.json'))) {
    return 'laravel'
  }
  if (existsSync(path.join(rootPath, 'go.mod'))) {
    return 'go'
  }
  if (existsSync(path.join(rootPath, 'angular.json'))) {
    return 'angular'
  }
  if (existsSync(path.join(rootPath, 'next.config.js')) || existsSync(path.join(rootPath, 'next.config.mjs'))) {
    return 'next'
  }
  if (existsSync(path.join(rootPath, 'package.json'))) {
    return 'node'
  }
  return 'next'
}

// STAGING_BASE now loaded from DB inside handlers via getSetting()

async function getRepoUrl(rootPath: string) {
  try {
    const gitDir = path.join(rootPath, '.git')
    const stats = await stat(gitDir)
    if (!stats.isDirectory()) return null
    const result = await runCommand(`git -C "${rootPath}" remote get-url origin`)
    if (result.code !== 0) return null
    return result.output.trim() || null
  } catch {
    return null
  }
}

async function discoverProjects(basePath: string) {
  const entries = await readdir(basePath, { withFileTypes: true })
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)

  const candidates: CandidateProject[] = []

  for (const dirName of directories) {
    const rootPath = path.join(basePath, dirName)
    const repoUrl = await getRepoUrl(rootPath)
    candidates.push({
      name: dirName,
      slug: slugify(dirName),
      repoUrl,
      rootPath,
      pm2Name: dirName,
      defaultBranch: 'main',
      projectType: detectProjectType(rootPath),
    })
  }

  return candidates
}

export async function GET() {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])

    const productionPath = await getSetting('PRODUCTION_PATH')
    const candidates = await discoverProjects(productionPath)

    const { rows } = await query<{ root_path: string }>(
      'select root_path from projects'
    )

    const existingPaths = new Set(rows.map((row: { root_path: string }) => row.root_path))
    const available = candidates.filter((candidate) => !existingPaths.has(candidate.rootPath))

    return NextResponse.json({
      basePath: productionPath,
      total: candidates.length,
      available: available.length,
      candidates: available,
    })
  } catch (error) {
    return jsonError(error)
  }
}

export async function POST(request: Request) {
  try {
    const user = await getSessionFromCookie()
    requireRole(user, ['admin', 'operator'])

    const basePath = await getSetting('PRODUCTION_PATH')
    const stagingBase = await getSetting('STAGING_PATH')
    const body = await request.json().catch(() => null)
    const allowedPaths: string[] | null = body?.paths || null

    const candidates = await discoverProjects(basePath)

    const { rows } = await query<{ root_path: string }>(
      'select root_path from projects'
    )

    const existingPaths = new Set(rows.map((row: { root_path: string }) => row.root_path))

    const toCreate = candidates.filter((candidate) => {
      if (existingPaths.has(candidate.rootPath)) return false
      if (allowedPaths && !allowedPaths.includes(candidate.rootPath)) return false
      return true
    })

    const created: CandidateProject[] = []

    for (const candidate of toCreate) {
      // Create as production project
      const { rows: inserted } = await query<CandidateProject & { id: string }>(
        `insert into projects
          (name, slug, repo_url, default_branch, project_type, root_path, pm2_name, environment)
         values ($1,$2,$3,$4,$5,$6,$7,'production')
         returning id, name, slug, repo_url, default_branch, root_path, pm2_name`,
        [
          candidate.name,
          candidate.slug,
          candidate.repoUrl,
          candidate.defaultBranch,
          candidate.projectType,
          candidate.rootPath,
          candidate.pm2Name,
        ]
      )
      const prod = inserted[0]
      created.push(prod)

      // Auto-create staging counterpart
      const stagingSlug = `${candidate.slug}-staging`
      const { rows: existingStaging } = await query<{ id: string }>(
        `select id from projects where slug = $1`,
        [stagingSlug]
      )

      if (body?.createStaging === true && existingStaging.length === 0) {
        const folderName = path.basename(candidate.rootPath)
        await query(
          `insert into projects
            (name, slug, repo_url, default_branch, project_type, root_path, pm2_name, environment, production_id)
           values ($1,$2,$3,$4,$5,$6,$7,'staging',$8)`,
          [
            `${candidate.name} (Staging)`,
            stagingSlug,
            candidate.repoUrl,
            candidate.defaultBranch,
            candidate.projectType,
            path.join(stagingBase, folderName),
            `staging-${candidate.pm2Name}`,
            prod.id,
          ]
        )
      }
    }

    return NextResponse.json({ created })
  } catch (error) {
    return jsonError(error)
  }
}
