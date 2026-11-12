# Service upgrades

Manager 2.33 adds reviewed upgrades to **Runtimes & tools** on connected servers.
Choose **Check for updates**, then **Update** on the selected service. Manager
automates download, verification, installation and readiness after an administrator
reviews the plan. It does not silently schedule upgrades or upgrade every service.
The Manager host's phpMyAdmin updater uses the same complete-release transaction.

## Supported installations

| Service | Windows x64 | Linux x64 / ARM64 | Scope |
| --- | --- | --- | --- |
| Private phpMyAdmin | Supported | Supported | Complete client release; existing PHP, configuration, secret and sessions retained |
| Caddy | Supported | Supported | Direct native service or this agent's private PM2 process; official binary must contain every existing module |
| PostgreSQL | Supported | OS package maintenance required | Same major version; standalone native service |
| MySQL / MariaDB | Supported | OS package maintenance required | Same major/minor series; standalone native service |
| MongoDB Community | Supported | Matching Ubuntu/Debian vendor archive required | Same major/minor series; standalone native service |
| Redis | Existing licensed Windows installation requires vendor maintenance | Supported | Same major/minor series; standalone native service; source build requires build tools |
| Composer / Sling / sqlcmd | Supported | Supported | Selected CLI only; sqlcmd updates do not update or restart the SQL Server engine |
| Angular CLI | Supported | Supported | New private installation and tool selection; project dependencies remain unchanged |
| PM2 | Supported | Supported | This agent's private daemon and application definitions only |
| Git | Separate portable copy selected for this agent | OS package maintenance required | Existing full/portable Git installation and other software are untouched |
| Node.js / Go / Windows PHP | Existing separate-version installer | Node.js / Go separate-version installer | Existing project version pins remain available |

Linux package-owned databases, Git, PHP and Python, Windows Python, SQL Server
engine upgrades and licensed Windows Redis upgrades retain their OS/vendor
maintenance workflow. The UI explains that boundary and allows rediscovery and
reuse afterward. Native service wrappers such as NSSM/WinSW, shared externally
managed proxies, custom Caddy builds missing official modules, replication,
clusters and database major migrations are outside automatic replacement.
ARM64 asset selection is supported where listed; the isolation matrix executes x64.

## Review and preservation

1. Select the connected server and service. Supply the existing executable and,
   for a native service, its exact service name, configuration and database data
   directory. Custom paths are supported; Manager does not assume OS defaults.
2. Verify SSH access and the server fingerprint, inspect the inventory and review
   the selected versions and paths. A review expires after ten minutes and is
   rejected if the inventory or selection changes.
3. For a standalone database, arrange a maintenance window, pause all writers and
   supply an existing administrator credential. This includes writers outside
   Manager. Do not use this procedure for a replication primary with disconnected
   replicas: automatic discovery cannot establish every external dependency.
4. Apply the reviewed plan. Keep writers paused until authenticated verification
   succeeds. Caddy restarts interrupt its selected sites briefly; PM2 maintenance
   restarts applications owned by that private daemon. The review identifies this
   scope. Unrelated process managers and services are not restarted.

Official release URLs and SHA-256 digests (or npm integrity) are resolved by
Manager and checked on the target. Each candidate reports the reviewed version
before activation. Downloads fail closed if assets are missing or ambiguous.
Native service registration, account, startup mode and configuration are captured
and checked again during maintenance. An authenticated database must match both
the selected data directory and the selected operating-system service process.

Database updates stop that service, make and hash-check a cold copy of its data,
then replace the selected binary files. Linked/special files, insufficient backup
space, detected replication and conflicting active work block the operation.
Existing service registration, database data, credentials, application files,
DNS and proxy configuration are preserved. Maintenance records block conflicting
application, storage, agent-update and Manager-update work until resolved.

phpMyAdmin stages a fresh code directory, copies its existing configuration and
preserves sessions and private PHP settings. It verifies CGI execution under the
agent account before selecting the new release. Remote phpMyAdmin continues to
use the existing agent relay, without adding a public listener. On the Manager
host, only the private phpMyAdmin helper restarts and its login page is checked.

## Recovery

Recovery files are retained under the operation's `backup` path. There is no
automatic deletion of service recovery copies.

- If verification fails before a database starts, Manager restores its previous
  binary files and starts the old service where safe.
- If the new database has started and verification fails, Manager stops it and
  keeps the operation pending for administrator recovery. It never automatically
  runs older binaries against potentially changed database data.
- **Verify the updated service** checks the selected release again.
- **Restore the previous release and cold backup** requires paused writers and
  the exact service name. It stages and verifies the backup before switching data
  directories. The current data directory is retained as
  `<data-directory>.manager-recovery-<operation-id>`. The active database returns
  to its pre-update contents; later writes are available only in the retained copy.
- Recovery refuses changed service registration, configuration or binary files.
  Interrupted restoration can be retried; do not delete journals or data folders
  to bypass a blocker. Host phpMyAdmin interruption retains its journal and may
  require administrator recovery; it does not yet have the remote recovery form.

Isolation tests cover service restarts, account permissions, authenticated data
preservation, tool restoration, database cold-backup restoration, failed readiness
and interrupted rename recovery. They do not establish power-loss or OS reboot
recovery. Production services are not upgraded as validation fixtures.
