# Manager updates and recovery

Manager 2.21 adds **Settings → Manager updates**. Administrators can check the
public GitHub repository, download a compatible release, or upload the same
package from another computer. Verification and staging happen first. **Install
update** starts a durable operation outside the Manager process. The page polls
its progress and reconnects after the restart.

## Package and publisher trust

The release workflow builds Windows x64 packages separately on Node 22 and 24:
`manager-update-win32-x64-node22.tar` and `manager-update-win32-x64-node24.tar`.
The package contains a prebuilt application, its dependencies, a manifest with
its SHA-256 digest, and a GitHub/Sigstore build attestation over that manifest.
No dependency downloads or build commands run during installation.

Both online and offline imports verify the certificate chain, transparency-log
proof and timestamp, GitHub Actions issuer, exact repository/workflow/tag,
source commit, manifest digest and payload digest. Trust material comes from the
installed application; an uploaded package cannot supply a replacement trust
root. Paths, duplicate entries, links, Windows special filenames, extraction
size, OS, architecture, Node major, minimum version and downgrade checks are
enforced before activation. Only additive, backward-compatible database schema
releases are accepted by this updater protocol.

Offline computers need only the `.tar` update asset. Fresh installers and full
offline installers are different packages. The release workflow must run from
the release tag, including when dispatched manually. Publishing a release tag
with this workflow produces the signed assets; a source ZIP alone is never an
update package. No long-lived release signing secret is required.

Maintainers refresh the committed Sigstore trust material with
`node scripts/refresh-update-trust.cjs` on a connected development computer.
This uses TUF-verified trust metadata. Include refreshed roots in regular
releases before signing authorities rotate. An offline institution that has
missed a trust transition needs an administrator-assisted bridge upgrade;
verification is never silently disabled. Offline verification cannot learn
about revocations published after its trusted-root snapshot.

## Existing and new installations

New Windows installations register the independent updater automatically.
Existing Managers need one bootstrap upgrade to 2.21 before the button exists.
The existing full offline upgrade from 2.19/2.20 also registers the updater.

### One-time online bootstrap (Windows Manager 2.17–2.20)

Download `bootstrap-manager-upgrade.ps1` from the official
[2.21.0 release](https://github.com/elimichaells/synergy-deployer/releases/tag/v2.21.0),
then run in an **Administrator PowerShell**, supplying your installation folder:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\bootstrap-manager-upgrade.ps1 -ManagerRoot C:\web\manager
```

The script selects the package for the registered Node 22 or 24 runtime,
verifies its standalone bootstrap runtime against the SHA-256 embedded in the
release script, then cryptographically verifies the signed update. It stages
outside Manager, registers independent recovery, backs up, installs and checks
health automatically. No Git checkout, npm install, build or manual job editing
is needed on the target server. The same command replaces an explicitly marked
local 2.21 preview with the official 2.21 release; it cannot reinstall or downgrade
an already published release.

Run while no administrator is deploying or changing databases. The bootstrap
rejects active jobs. Old versions do not yet have the new maintenance gates,
so keep other administrators out until the bootstrap finishes. Existing hosted
applications keep running. If verification or backup fails, source is not
activated; if startup fails, recovery restores the previous release.

For a custom institutional hostname, add `-ManagerUrl https://manager.example.edu`.
For an internal Caddy CA, add `-CaCertificate C:\certificates\caddy-root.crt` as
well. Otherwise the installer report or configured Manager domain is used.
Custom startup registrations can pass `-StartupConfig` and `-StartupTask`.

### One-time offline bootstrap

On a connected computer, download these three assets from the same official release:

- `bootstrap-manager-upgrade.ps1`
- `manager-bootstrap-runtime.zip`
- `manager-update-win32-x64-node22.tar` or `manager-update-win32-x64-node24.tar`,
  matching the Node major version on the Manager host (copy both if unsure).

Transfer them together and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\updates\bootstrap-manager-upgrade.ps1 -ManagerRoot C:\web\manager -OfflineDirectory D:\updates
```

The offline command performs the same signature and integrity checks without
network access. Obtain the initial script from the official release over HTTPS;
it supplies the first trust anchor on Managers that do not have an updater yet.
The bootstrap ZIP and script also have GitHub build attestations. These are
Sigstore/GitHub signatures, not Windows Authenticode signatures.

Developer builds may still use `stage-local-manager-update.cjs` from an isolated,
tested checkout. That administrator-only CLI labels packages as local builds;
the dashboard and published bootstrap never accept unsigned update packages.

The Windows installer currently supports its standard SYSTEM PM2 service
identity. Manager, recovery data and staged releases must share a volume for
atomic renames. Registration protects recovery files for SYSTEM and local
administrators, creates a recurring/startup recovery task, and wraps the
existing PM2 boot task so file recovery precedes resurrection. It preserves the
original boot action. Hosted Windows and Linux servers are independent of the
Manager host OS; this feature does not change their deployment support.

## Installation and recovery behavior

Before replacement, the worker validates the process identity, staged file
inventory, disk space and active jobs. A maintenance marker blocks mutations,
webhooks, agent claims and new scheduled work. SSH setup and manual database
backup/restore operations hold durable leases; the updater waits for the user
to finish active work before a retry. Background initialization waits until the
worker has committed activation.

Only Manager and its running pgweb/phpMyAdmin helpers restart. Hosted apps,
Caddy, database engines and the PM2 daemon stay running. The worker makes a
custom-format Manager database dump, verifies its table of contents, and saves
`.env.local`, PM2 dumps and the configured Caddyfile. Protected credentials and
runtime data are not replaced by an update. Remote jobs are not replayed.

Every replacement intent is written and flushed before a filesystem rename.
The previous release is retained. Health checks require the expected running
version, a database query, local HTTP and the configured Caddy HTTPS route with
certificate verification. Failure restores the previous application. Recovery
is repeatable even if power fails during rollback. The recurring task can
recover when Manager is down; the boot wrapper restores files before PM2 starts.

**Restore previous release** restores application files, preserving compatible
additive schema changes and subsequent user data. Database snapshots are not
automatically restored: doing so could erase work performed after an update.
Breaking schema migrations require a separate maintenance/restore plan and are
outside this protocol. Backups and failed releases remain until an administrator
archives them; there is no automatic recovery-copy deletion.

If automatic recovery fails, maintenance remains on. Read the job's protected
`state.json` in the recovery directory shown in Settings. Retry from the UI if
Manager responds, or run the registered Node executable with:

```text
<recovery-directory>/runner/manager-update-worker.cjs <manager-root>/.manager-updater.json run
```

Do not delete `previous`, the database dump, or the maintenance marker to force
an update through. A stale operation lease records its PID and operation name;
an administrator must establish that the process and any child operation have
ended before removing it. An interrupted preparation can be cancelled in the
UI after 35 minutes. The protected `prepare.lock` directory is only held while
creating a job; after a host failure, check that no preparation request remains
before removing an orphaned lock. Do not run a second worker while its recorded
PID is alive.

This updater updates Manager application code and dependencies. Node, database
engines, Caddy, the PM2 daemon and remote agents have separate lifecycles.
