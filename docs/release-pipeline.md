# Release Pipeline And Application Groups

## Deployment Lifecycle

Manager prepares each candidate in a private, per-project sibling workspace:

`<application-parent>/.manager-releases/<project-id>/<deployment-id>/`

The current application directory, PM2 process, and assigned port remain unchanged during checkout, dependency installation, build, and audit. Source changes and private environment changes made during the build stop activation. Deployment scripts must use candidate-relative paths and must not control PM2 or Caddy themselves.

Activation briefly stops the application's process and its running, directory-associated workers. Scheduled project jobs cannot start during activation, and an already running job blocks activation. On Windows, the verified preview is also stopped and its process tree is checked before activation. Manager leaves the live project directory and existing persistent data in place, archives replaceable code/dependencies under the private previous-release directory, and installs the candidate code into the original project path. Each move is recorded before and after execution in an atomically replaced, flushed journal. PM2 then starts on the original port and health is checked. A failed activation reverses completed code moves and restores the captured PM2 definition, including its original environment. Other applications are not restarted.

On other platforms, activation retains the whole-directory strategy: previous source is moved aside, current application-local data is transferred into the candidate, and the candidate moves to the original path. Windows uses individual code moves because open project/storage directories can prevent a whole-directory rename even after application shutdown.

This is a short-restart deployment, not a zero-downtime blue/green proxy switch. Database migrations in custom scripts or pre-deploy commands operate on the configured database and are not automatically reversed. Use backward-compatible migrations while the previous release is serving traffic.

## Persistent Files

Ignored and untracked local paths are retained across activation, excluding dependency/build artifacts and Manager recovery directories. Standard upload, Laravel storage, and private environment paths are retained. Mutable directories are not copied wholesale during preparation; tracked placeholder files are preserved for framework builds. On Windows, existing persistent paths and their parent containers remain in place, including nested paths such as `public/uploads` and `database/database.sqlite`. Data written during a build or before a failed health check is preserved. New persistent directories supplied by the candidate are installed when no live counterpart exists.

Git-tracked dependency/build outputs, linked application roots, and shared Git worktrees are rejected before activation. Prepare an independent source checkout for these projects. Laravel absolute-path caches are regenerated at the stable application path during activation.

Previous code, failed candidates, dependency snapshots, and rollback definitions are retained under the policy below. The Windows previous-code directory is not a standalone backup of persistent data: that data remains in the live project and needs its normal backup schedule. Private release directories are protected for Windows Administrators and SYSTEM. Do not serve them through a static file server.

### Release storage cleanup

Infrastructure > Disk cleanup shows free space, a background scan, protection reasons and recent cleanup activity. An administrator can scan without deleting, clean expired files after reviewing the scan, and enable daily automatic cleanup. Automatic cleanup is opt-in; it checks hourly and runs at most once per day while Manager is running. Its work is registered with the self-updater so an update waits for it to finish.

The policy always protects the current deployment's workspace (including its rollback definition), the three newest successful workspaces still present, successful releases less than seven days old, failed builds less than three days old, and the newest dependency snapshot. Other regenerable dependency caches expire after seven days. A `.keep` file in a release/cache folder pins it indefinitely. Deployment rows and logs are never deleted.

Cleanup only derives paths from registered applications and verified release journals. Missing/mismatched records, unfamiliar entries, and unsafe recovery states are kept for review. Any interrupted activation or restore protects the whole application's release directory. A project admission lock prevents deployment/console/checkout races; running or queued deployments are skipped. PM2 definitions (including stopped processes and runner settings), registered app roots and scheduled job paths/commands are checked again immediately before removal. Process-inspection failure or lock loss stops deletion. Linked release roots are rejected; nested links are unlinked without following their targets. Files in live applications, uploads, databases, database backups, Manager update/recovery storage and global package caches are outside this policy.

The page currently manages release storage on the Manager host. Remote-agent application directories have their own layout and are not swept by this feature. Folder sizes and removed-byte totals are estimates; filesystem sharing and other disk activity can change the actual free-space increase. A disk warning does not relax the retention protections: if the protected files leave too little space, free unrelated data deliberately or expand the volume. Interrupted/partial cleanup is recorded, preserves the journal until the end, and may be retried by a later run.

An interrupted activation leaves `release.json` with the paths, phase and completed moves. New deployments fail closed until that journal is inspected and recovery is completed. Do not blindly rename or delete these directories after a host crash.

## Terminal locks during Windows activation

Keeping the root and persistent paths in place allows deployment while Explorer or a terminal has those directories open. Windows activation no longer attempts to rename the root or force-close those sessions. It still stops and verifies the application's own process tree and its verified preview before replacing code.

A lock on a code file or dependency directory that actually needs replacement can still block a move. Moves have bounded retries; a remaining failure triggers rollback. The log identifies processes with directories open inside the project, including Explorer, editors, or Manager itself. Names and PIDs are diagnostic evidence; not every open directory handle prevents a rename. Command lines and opened filenames are not logged, and unrelated desktop processes are not closed. The earlier scoped terminal-recovery helper remains available for explicit whole-directory operations, but is not needed by the default Windows activation strategy.

An idle browser console page does not create a persistent shell: each Manager console command runs separately, with project operation admission held until the command finishes. A command that deliberately starts a detached process can outlive its shell and still require investigation.

## Verified Dependency Reuse

Reusable snapshots require a standalone `npm ci` command, a lockfile, and no root install/prepare lifecycle hooks, workspaces, or local/linked dependencies. Other commands still run normally but are not eligible for dependency-tree reuse.

The cache identity includes package.json, the lockfile, effective npm configuration, command flags, Node version/ABI/platform/architecture, npm version, and the supplied installation environment. Only hashes are persisted in cache receipts, never the input secrets. Snapshot files are content-verified before reuse and copied into the candidate; builds do not share writable dependency directories with each other or with the live app. Corruption triggers a fresh installation and quarantines the invalid snapshot.

The first qualifying deployment installs and warms its cache. A changed lockfile, runtime, configuration or install environment intentionally invalidates reuse. Each project and environment has its own cache.

Install commands prefer npm's package cache and suppress the incidental audit/funding requests. This does not disable the separate security gate. See [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/) and [npm configuration](https://docs.npmjs.com/cli/v11/using-npm/config/).

## Capacity And Security

The host defaults to one concurrent heavy installation. `MANAGER_INSTALL_CONCURRENCY` may be set to an integer from 1 through 4 in Manager's environment, followed by a Manager restart. Installation slots use PostgreSQL session locks across route bundles and Manager processes. Waiting deployments report queue progress and can be cancelled. A disconnected lock session cannot approve activation.

Every final Node candidate, including cache hits and custom-script deployments, runs a fresh `npm audit --json --package-lock-only --omit=dev --audit-level=high`. High/critical production findings, registry errors, invalid reports, and missing lockfiles block activation. The deployment log lists affected packages, advisory links, inherited dependency findings, and npm's available fixes, including whether a major upgrade is required. Long reports are bounded; run the logged audit command in the retained candidate for the full report. No automatic `npm audit fix` or forced dependency upgrade is performed. Composer projects with a lockfile also run `composer audit --locked --no-interaction`. Go projects without Node/Composer manifests do not yet have a Go vulnerability-scanner gate.

Application repositories should also audit with `--include=dev --audit-level=high` on pull requests and a daily schedule, alongside clean-install builds and tests. Build-only dependencies belong in `devDependencies`, but still need updates. Commit reviewed lockfile changes and keep framework/toolchain versions supported. A passing audit reflects the advisory database at that time; it is not a permanent security guarantee.

Audit findings can change without source changes. See [npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit/).

### Builds and memory

Builds take turns and wait for free memory. Each build first needs a build slot (`MANAGER_BUILD_CONCURRENCY`, default 1, at most 4) and at least `MANAGER_BUILD_MIN_FREE_MB` of available memory (default 2048). While waiting, the log shows how much is free and what is needed, and the live release stays online. After 30 minutes of waiting the deployment fails without touching the live app. The retry from scratch after a failed cached build also waits for a slot. Custom deployment scripts are not gated, because install and build happen inside them.

An app can have a memory limit (app Settings > Memory). For Node.js apps it becomes `--max-old-space-size` at three quarters of the limit, added to the app's own `NODE_OPTIONS` and replacing any earlier heap cap; the test start and the live start both use it. A limit applies the next time the app starts. For every app, the manager warns when the app's whole process tree stays over its limit.

### Start methods

Apps whose start command needs a shell are started through the manager's runner (`scripts/pm2-runner.js`), which costs a Node process, two shells and, for `npm start`, an npm process: about 70 to 130 MB per app. An app can instead be started directly by PM2 when its start is one of: `next start` (run from `node_modules/next`, always on the assigned port), `node <script>` with only `--flag` options, or a native `.exe`; reached directly or through `npm start` / `npm run <name>`, optionally behind `cross-env NAME=value`. It must keep the runner when npm runs a `pre` or `post` script around it, the command uses quotes or shell operators, the app pins its own Node version, it is a PHP app, or its script starts child processes (a parent PM2 stops could leave the child holding the port).

Nothing changes until an app is switched on Infrastructure > Memory. Switching stops the app, waits until its port is free, starts it directly and health-checks it; if it is not healthy it is started through the runner again and the method is not changed. A switched app's deployments then test-start and start it directly. If a later commit makes its start ineligible, deployments fall back to the runner rather than failing.

### Sleeping staging apps

A staging app can sleep after 30 minutes to 8 hours without use (app Settings > Sleep when idle, or Infrastructure > Memory). Use is read once a minute from open inbound connections on the app's port; a deployment also counts. A sleeping app is stopped with PM2 and wakes when it is deployed, when someone presses Wake now, or when someone opens its address: its Caddy site gets a `handle_errors` block that sends a 502 to the manager's public `/api/wake` page, which starts the app and shows a "starting up" page that reloads itself. That page needs no session; it only acts on host names of staging apps with sleeping turned on, and it starts at most one wake per app every 90 seconds. Production apps never sleep.

### Database server memory

Infrastructure > Memory shows each database server on the machine (found through its Windows service, matched to the manager's saved connection by port): its memory, data size, open and idle connections, the apps linked to it, and logins holding many idle connections. Inspection uses the saved admin connection and only reads.

For MySQL and MariaDB it recommends memory settings: turning off performance_schema (its measured memory), turning off the X protocol when nothing has used it since startup (MySQL only), and a 16 MB innodb_log_buffer_size. An administrator chooses which to apply. `scripts/tune-database-memory.ps1` saves the current file as `my.ini.before-tuning-<time>`, writes the settings (prefixing X protocol options with `loose-` when it is turned off), has MySQL check the file with `--validate-config` before anything restarts, restarts the service and waits for its port. If the server does not come back, the previous file is restored and the server restarted again. Apps lose their database connection while it restarts, usually 10 to 30 seconds. PostgreSQL servers are shown but not tuned; their settings are already modest, and idle connections are the cost to look at.

### Moving a database to another server

A PostgreSQL database can be moved to another PostgreSQL server on the same machine from its Storage page (Plan the move). The plan lists every app that uses it, the env files that will change, the extensions it needs, open connections, and a downtime estimate; it refuses to start when an app using the database is not linked, a deployment is running, the target lacks an extension, pg_dump is older than the server, or there is not enough disk space. An administrator types the database name to start it.

The move creates an empty database on the target owned by a new login with no other rights (and the source's extensions, created by the target's admin), waits for the apps' scheduled jobs to finish (new ones do not start while it runs), stops the apps and their workers, and closes the manager's own browsing connections. If anything else is still connected after 30 seconds it stops. It then copies the database with pg_dump (directory format, kept under backups\database-moves as a backup) and restores it with --no-owner --no-acl as the new login, compares every table's exact row count, every sequence value and the number of views, indexes, functions, types and triggers, and checks the new login owns everything. Only then are the apps' env files rewritten (originals saved under backups\manager-env), the apps started and health-checked, workers resumed, and the manager's records switched to the new server and login. Any failure puts the env files back, restarts the apps on the original database, which is never changed, and removes the unfinished copy. The original stays in place until it is removed from Storage.

### Temporary advisory exceptions

Manager administrators can create `security-exceptions.json` in Manager's working directory, or set `MANAGER_SECURITY_EXCEPTIONS_FILE` in Manager's own environment to an absolute file path and restart Manager. Protect this file with administrator-only write access. Never place it in an application's checkout. The default file is Git-ignored. An absent file means no exceptions; malformed configuration blocks deployment.

The file contains an array. Each entry requires the exact Manager project/environment ID, affected package, GHSA advisory, a review reason, and an expiration timestamp in UTC:

```json
[
  {
    "projectId": "replace-with-exact-manager-project-id",
    "package": "sharp",
    "advisory": "GHSA-rgj7-g3m4-5g8c",
    "reason": "Describe reviewed exposure, mitigation, and dependency update plan",
    "expiresAt": "2026-10-02T00:00:00Z"
  }
]
```

This is an example, not an enabled exception. Review the complete candidate audit before adding entries. Parent findings are resolved to underlying advisories; every advisory in the dependency path must be covered. New advisories, other projects (including staging), expired exceptions, unresolved dependency paths, registry failures, and invalid reports still block release. Both pre-install and final audits reload the policy and check expiration. Logs record each accepted advisory, reason, expiration and original high/critical counts. The gate's `passed` status means policy approval; consult the log to distinguish approval with exceptions from a clean audit.

Remove entries or replace the file contents with `[]` to revoke exceptions for subsequent checks. Expiration does not stop or repair an already running application. Upgrade dependencies, test, commit the lockfile, and redeploy to remove the exposure.

### Deploying past the gate

When the gate stops a release, the deployment page lists the affected packages, their advisories and the commands that fix them. Fixing the packages and pushing is the recommended path and needs no special permission.

An administrator can instead choose **Deploy anyway**. This asks for a written reason and an explicit acknowledgement, and for how long it applies:

- **This deployment only.** The next deployment is checked and blocked as usual.
- **This app, for 7 or 30 days.** Every deployment of that app in the period, including automatic ones, goes live regardless. The gate comes back on by itself.
- **This app, until someone turns the gate back on.**

The same switch is under the app's Settings > Security gate. Turning the gate off needs an administrator; operators can turn it back on. While it is off, the app page shows a banner with who turned it off, when, why and until when.

An override does not skip the audit. Both audits still run, every finding is written to the deployment log, and `[security] OVERRIDE` lines record the reason and whether it came from the deployment or the app. Such a release is stored with security status `overridden` and shown as "Released with known vulnerabilities"; a release with nothing to block is still `passed` even while the gate is off. The decision is written to the audit log (`deployment.security_gate_overridden`, `security_gate.turned_off`, `security_gate.turned_on`). A missing lockfile, a failed build and a failed test start still stop the release. A promotion that was stopped is re-run as the same promotion, with the staging commit confirmed again.

An override does not make the application safe. Prefer a per-advisory exception when one specific finding has been reviewed, and prefer the shortest period that covers the planned fix.

For every application repository, add the audit command to pull-request CI and a daily scheduled workflow, followed by its clean-install build and meaningful tests. Dependency update automation should open reviewed pull requests rather than force major upgrades during deployment. These repository checks must be configured in each application's own CI; Manager's release gate remains the final check.

Deployment history reports the current phase, security failures, and an explicit active-release marker. A failed build does not replace that marker.

## Staging And Related Applications

New application setup offers **Production only**, **Staging only**, or **Production + Staging**. A pair has separate branches, ports and setup states. Either single-environment choice creates one app and reserves one port. Standalone staging uses the staging install directory and manages its own webhook; promotion requires a linked production app. Host discovery no longer backfills staging for existing applications. Existing staging environments are not removed.

Choose a component role and related application during creation, or open an existing application's **Overview > Link application**. Frontends, backend APIs and services can use different repositories and technologies. Linking production applications includes their existing staging counterparts automatically. Standalone staging apps can also join projects and are included in app counts and membership controls. A group does not merge databases, secrets, runtime settings, ports, domains or deployment triggers. Each component remains independently managed and deployed.

The group lists its component environments and provides direct links to databases, domains, environment configuration and the console. Unlink removes only the grouping relationship, not application data or deployments. Moving between existing groups requires an explicit unlink first.

## Verification

### Reliability release 2.15

Application readiness is distinct from the enabled setting, PM2 process status and last deployment result. The dashboard and application overview use the independent monitor's observations; missing or stale observations show unknown. Under app Settings, administrators and operators can set a local readiness path, explicit expected HTTP codes and a startup deadline (5–180 seconds). Defaults require 2xx. Same-origin redirects are followed to their destination; redirect loops, external redirects, 404 and failing pages do not pass by default. The same profile applies to monitoring, deployment preflight, final checks and recovery.

Health & alerts combines monitor incidents, memory alerts, failed/interrupted backup schedules and active security gate overrides. Failed database sources produce an unavailable warning and have bounded connection/query waits. Alert delivery stays inside Manager; the independent Windows monitor keeps collecting when Manager is down, and incidents are visible after access returns. Monitor incidents retain their existing debounce/recovery policy. Database-backed alerts reflect their current source state.

Deployment output is batched into delta writes. The detail endpoint accepts `after=<character offset>` and returns bounded `log_chunk`, `log_next`, `log_reset` and `log_complete` fields; Unicode offsets count PostgreSQL characters. Omitting `after` retains the complete-log response. The UI drains remaining output before stopping after completion and bounds rendered output. Log persistence failures cannot bypass rollback.

Git diagnostics distinguish checkout ownership, permissions, locks and missing Git without exposing raw command output. Deployment Git commands trust only the explicitly configured working directory for that invocation. Next.js apps with custom package startup scripts must explicitly configure their start command so initialization is not silently bypassed.

The guarded Windows launcher is `scripts/start-manager-services.ps1 -ConfigPath <config.json>`. Configuration pins `nodeExe`, `npmPath`, `pm2Home`, `pm2PackageRoot` and `accountSid`. `-ValidateOnly` checks saved application paths and passively reads PM2 without changing processes. At boot it preserves intentionally stopped apps, leaves an already healthy daemon alone, rejects an unresponsive live daemon or incomplete registry, and restores only a validated saved list after a cold start. It never runs `pm2 update`, overwrites the saved list or falls back to an ecosystem file. Keep the previous scheduled-task XML and release build for rollback; verify a cold boot during a maintenance window.

Manual deployments from an application's page have a **Candidate preflight** checkbox, enabled by default. Unchecking it sends `preflight: false` for that deployment and skips the temporary-port start. The log records the choice. Builds, security checks, final health verification, and rollback still run. Other deployment entry points keep preflight enabled by default. Skipping the candidate check can interrupt service until final health succeeds or rollback restores the previous release.

The **HTTP health checks** checkbox is also enabled by default. Unchecking it sends `healthCheck: false` for this deployment and skips both candidate preflight and final HTTP health checks. This allows installing an application before its runtime database or other settings are ready. It does not bypass the build, dependency security gate, filesystem activation safeguards or PM2 start errors. HTTP 500 responses will not trigger rollback in this mode. Deployment logs and the release guarantees display explicitly state that readiness was not verified. Automated deployments retain the default checks.

When an enabled health check fails, Manager collects a bounded tail of the application's PM2 error log before cleanup or rollback. It adds runtime diagnostic lines and the error summary to the deployment failure, so errors such as missing settings, database role restrictions and connection failures appear in the deployment view. Known environment secrets, credential URLs and common password/token assignments are redacted.

Every deployment loads the saved application `.env` and `.env.local` for its build, candidate start and live start. Save edits before deploying; unsaved editor text is not applied. Managed database settings provide standard variables, not arbitrary application-specific connection names. An empty `DATABASE_OWNER_URL` must be configured with the required restricted database role; skipping preflight cannot supply credentials or repair HTTP 500 responses. Environment changes during a build require retrying the deployment to avoid activating a candidate built with stale settings.

- `npm test`: isolated unit, filesystem, orchestration, authorization, creation and grouping tests.
- `npm run typecheck`: TypeScript validation.
- `node scripts/build-verified-release.mjs`: builds a separate Manager candidate without overwriting the live build.
- `tests/pipeline-integration.test.cjs`: opt-in integration checks. `MANAGER_TEST_ADMIN_URL` creates and drops only a uniquely named scratch database; `MANAGER_TEST_NPM=1` tests actual npm installation/reuse/audits; `MANAGER_TEST_PM2=1` tests disposable local processes, live builds and failed-health rollback. Never pass customer database URLs as scratch targets or run the PM2 check against production application names.

The npm integration check temporarily downloads a small public fixture dependency. The PM2 check uses a uniquely named process and an ephemeral loopback port, then removes the fixture. Browser preview fixtures have no access to production databases, schedulers or APIs.
