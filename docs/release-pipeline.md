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

Previous code, failed candidates, invalid dependency snapshots, and rollback definitions are retained. The Windows previous-code directory is not a standalone backup of persistent data: that data remains in the live project and needs its normal backup schedule. Retained releases require disk-space monitoring and deliberate retention/cleanup; do not delete a workspace involved in a running deployment. Private release directories are protected for Windows Administrators and SYSTEM. Do not serve them through a static file server.

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

New application setup requires choosing **Production only** or **Production and staging**. Staging has a separate branch, port and setup state. Production-only creation does not reserve a staging port. Host discovery no longer backfills staging for existing applications. Existing staging environments are not removed.

Choose a component role and related application during creation, or open an existing application's **Overview > Link application**. Frontends, backend APIs and services can use different repositories and technologies. Linking production applications includes their existing staging counterparts automatically. A group does not merge databases, secrets, runtime settings, ports, domains or deployment triggers. Each component remains independently managed and deployed.

The group lists its component environments and provides direct links to databases, domains, environment configuration and the console. Unlink removes only the grouping relationship, not application data or deployments. Moving between existing groups requires an explicit unlink first.

## Verification

- `npm test`: isolated unit, filesystem, orchestration, authorization, creation and grouping tests.
- `npm run typecheck`: TypeScript validation.
- `node scripts/build-verified-release.mjs`: builds a separate Manager candidate without overwriting the live build.
- `tests/pipeline-integration.test.cjs`: opt-in integration checks. `MANAGER_TEST_ADMIN_URL` creates and drops only a uniquely named scratch database; `MANAGER_TEST_NPM=1` tests actual npm installation/reuse/audits; `MANAGER_TEST_PM2=1` tests disposable local processes, live builds and failed-health rollback. Never pass customer database URLs as scratch targets or run the PM2 check against production application names.

The npm integration check temporarily downloads a small public fixture dependency. The PM2 check uses a uniquely named process and an ephemeral loopback port, then removes the fixture. Browser preview fixtures have no access to production databases, schedulers or APIs.
