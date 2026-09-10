# Application Deployment Workspace

## Main Flow

1. Open **Applications > New application**. Choose the GitHub account and repository, name the application, and select a branch. Staging is optional. Ports remain automatically allocated. Auto deployment starts disabled.
2. **Repository:** prepare the checkout. An existing checkout is inspected without pulling or resetting it. Non-empty, non-Git directories are refused rather than cleared.
3. **Runtime & build:** confirm the detected framework, choose installed Node/PHP/Go versions, and review build/start commands. Optional deployment commands remain one multiline script. Open the dependency manager to install missing tools or side-by-side versions explicitly.
4. **Database:** provision an isolated project database or attach an existing database using its application username/password. Select the application-primary database deliberately. The existing migration wizard, password management and environment-sync review are available here. Angular must not receive database credentials.
5. **Environment:** edit the application's `.env` or explicitly select runtime variables only. The repository must be prepared before a draft's environment file can be written. Setup progress does not store environment contents or passwords.
6. **Domain & TLS:** choose manual DNS or a Cloudflare connection. Review the exact record and assigned application upstream before applying. Manual mode changes no DNS records. Existing unmanaged Cloudflare records are not overwritten. Zone-wide SSL mode is never changed by this flow.
7. **Review & deploy:** validate configuration, resolve blockers, then deploy. Warnings identify checks that require a running application, such as public HTTP/TLS reachability. Auto deploy can be enabled beside the Deploy button after setup is complete.

The **Setup** tab resumes the application's saved step. Existing applications are not made into incomplete drafts merely by opening the workspace. New registration and optional staging/setup records are created in one database transaction.

## Workspace Structure

- Applications: searchable environment-aware list, draft status and persistent deployment actions.
- Application workspace: overview, deployment history, guided setup, command console, existing environment/webhook controls and advanced settings.
- Jobs & workers: application filter; project links preserve context. Existing workers are associated by exact working directory; explicit worker ownership is a future schema improvement.
- Infrastructure: shared database connections, PostgreSQL administration, processes/Caddy and domains.
- Host & integrations: global settings, GitHub connections and host dependencies.
- Processes & Caddy: the existing configuration viewer and validation controls remain available.

## Reliability Boundaries

The console accepts single PHP, Composer, Go, Node, npm, npx, pnpm, yarn and Git commands. It uses selected project runtime paths and application environment values, not Manager's inherited database credentials. Shell chaining, expansion, pipes and redirection are refused. Execution streams output, emits quiet-period progress, supports cancellation and has a fifteen-minute limit. This is an operator command facility, not an OS security sandbox.

PostgreSQL advisory locks coordinate checkout preparation, console execution and deployment admission for one application. Other applications can continue operating. Role checks remain enforced by the server.

The existing deployment protections remain: dirty-checkout protection, fast-forward-only Git updates, ignored environment-file preservation, bounded dependency retries, Go entrypoint detection, dynamic ports, bounded health checks and real build failure reporting.

Configuration validation cannot guarantee that an application's source compiles, that migrations are correct, or that all application-specific secrets are present. Database credentials are tested when attaching resources; deployment validation does not perform a full migration rehearsal. DNS/TLS checks are not reported as healthy solely because configuration was saved.

Automatic HTTPS requires correct DNS and externally reachable challenge ports. See [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https). For Cloudflare's origin certificate requirements, see [Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/). Configure zone-wide changes separately after reviewing their effect on other applications.

## Verification

- 50 compiled TypeScript regression tests: deployment commands, Git safety, Go selection, ports/health, dependency preparation, setup decisions and console policy.
- 8 isolated server tests: advisory locks, draft gating, manual DNS isolation, domain ownership, unmanaged Cloudflare records and viewer permissions.
- Browser testing against synthetic APIs: repository selection/create, preparation, framework selection, database attachment with manual credentials, environment save, manual-domain confirmation, resumable review, blocked validation and PHP command entry.
- Desktop and mobile UI inspected at desktop 1280/1440 and mobile 390/320 frame widths. Test fixture source is excluded from production routes.
- `npm run typecheck` and optimized Next.js production build.

The fixture generator `node scripts/preview-workspace.mjs` creates a temporary UI-only workspace. It excludes production APIs, `.env`, authentication middleware, instrumentation and background schedulers. Run Next on a free loopback port inside that temporary directory. No fixture operation accesses real GitHub, databases, runtimes, Caddy or Cloudflare.

## Next Improvements

1. Immutable release directories with atomic activation and framework-aware rollback, replacing in-place builds.
2. A durable worker queue for installations, deployments and console sessions with reconnectable logs and crash recovery.
3. Repository-defined environment schemas and deployment manifests, including monorepo subdirectories and explicit health endpoints.
4. Project ownership for workers and per-project permissions rather than directory-based association.
5. Automated backup restore drills, migration rehearsals and post-deployment DNS/TLS checks before enabling unattended deployment.

No package upgrades, database-provider changes, credential rotations or Cloudflare modifications are required to activate this UI release.
