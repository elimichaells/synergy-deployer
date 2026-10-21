# Installing Manager without internet access

Use the **offline setup edition** (`manager-setup-offline-<version>-<timestamp>.exe`). The regular source installer still downloads dependencies. The offline executable carries the production Manager application, its locked npm dependencies (including Windows native modules), and the server tools. No Chocolatey bootstrap, npm install, npm version lookup, or Next.js build runs on the institution's server.

## Included components

- Node.js 22 LTS and its compatible bundled npm
- Git for Windows (MinGit, HTTPS repositories), Caddy, and PM2
- PostgreSQL 17, with separate control and application clusters
- Pgweb and the Sling migration engine
- Go, PHP 8.3, Composer, Python 3.13, and the Visual C++ runtime
- Dashboard packages: MySQL 8.4.13, MariaDB 11.4.13, MongoDB 7.0.45, SQL Server 2022 Express and phpMyAdmin 5.2.3

SQL Server includes the October 2026 GDR security update, KB5128493 (16.0.1210.3), and verifies that version after installation. The updater targets only the new `MANAGER` instance; an existing SQL Server instance must be connected instead of installing alongside shared SQL components. [Microsoft update details and checksum](https://support.microsoft.com/en-us/servicing/sql/sql-server-2022/general-distribution-release/kb5128493-october-2026).

Exact versions, publisher download locations, and SHA-256 values are pinned in `installer/offline/dependencies.lock.json`. PM2 has its own npm lockfile. Each generated bundle includes `offline/manifest.json` and third-party notices. Preflight verifies every bundled file and the Manager version, source commit, architecture and npm lock before installing anything. Missing or changed files stop setup; there is no internet fallback.

Starting with 2.20.0, the optional packages are saved to `C:\ProgramData\Manager\offline-services` during installation. Install them from **Infrastructure → Runtimes & tools** after Manager is running. Their initial wizard controls remain disabled because their credentials and provisioning connections are created through the dashboard. PostgreSQL covers Manager's own database requirements. Redis uses an existing institution Redis server; Memurai Developer is not bundled.

The dashboard verifies each local archive before installation and does not fall back to Chocolatey or the internet. Services use automatic Windows startup and loopback listeners: `ManagerMySQL` on 3306, `ManagerMariaDB` on 3307, `ManagerMongoDB` on 27017 and `MSSQL$MANAGER` on 1433. An occupied port or an unowned service/data directory stops installation without replacing it. Connect the existing database under Data connections instead.

Installation generates machine-protected credentials, creates an authenticated persistence check, restarts the database, verifies the same data and registers an encrypted provisioning connection in Manager. MySQL/MariaDB also activate phpMyAdmin at the administrator-protected `/mysql/` route. phpMyAdmin offers both database ports. Database files and receipts live under `C:\ProgramData\Manager\services`; preserve these directories. Interrupted initialization is not automatically repeated over existing data. Online update/version controls are disabled in offline mode.

## Upgrade an existing offline Manager

For an already installed 2.19.x or 2.20.x server, use the **offline ZIP**. Do not rerun the fresh-installation wizard against the existing installation. Back up Manager and its databases, finish active deployment/install jobs, and confirm Manager HTTPS works first. Extract the ZIP outside the installed Manager directory, then run from administrator PowerShell:

```powershell
Set-Location C:\ManagerUpgrade\manager-2.20.0
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\upgrade-manager-offline.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\upgrade-manager-offline.ps1 -Apply
```

Use the actual extracted directory. The first command verifies the package and installed instance without applying changes. The second replaces application code and dependencies, preserves `.env.local`, databases and existing deployments, saves optional packages, and verifies HTTPS. Application files are restored if startup verification fails. Recovery files remain under `C:\ProgramData\Manager\Recovery`; retain them until acceptance. Allow at least 8 GB free for staging/recovery, plus package extraction and database storage. Reserve additional space before installing all optional databases.

GitHub's OAuth client ID is now saved under **Settings → Connections → GitHub application** in Manager's database. An existing environment value is imported only when the database setting does not exist. Later saves take effect without restarting Manager. Enable device flow on the GitHub OAuth app; this flow does not use a client secret. GitLab and Gitea settings remain available for institution repositories.

## Install on Windows Server 2019

1. Copy the complete offline executable and its `.sha256.json` receipt using approved removable media or a local share. Compare `Get-FileHash -Algorithm SHA256 <installer.exe>` with the receipt before running it.
2. Sign in as an administrator and run the executable. Server 2019 Desktop Experience is needed for the GUI; the accompanying ZIP has `setup.cmd` for command-line installation.
3. Choose the embedded package and **Institution / local network**. Enter the server's stable IP address or institution DNS hostname. Local HTTPS does not contact a public certificate authority. Public certificate issuance requires internet access and is rejected during offline preflight.
4. Choose a dedicated empty Manager directory, administrator credentials and a PostgreSQL administrator password. Keep Apache stopped and disabled; Caddy needs ports 80 and 443. Allow at least 10 GB free on both the system/cache drive and the installation drive, with additional space for deployed applications and databases.
5. Keep both PostgreSQL clusters selected on a fresh server. If using an existing control PostgreSQL server, deselect control database installation and provide its existing credentials. Never delete an existing database directory or `.env.local` to force installation.
6. Run preflight, then installation. It must report **Offline dependencies: PASS**. Bundled Node.js/npm are used even if “current npm” was selected in a custom configuration.
7. Open the displayed URL. Distribute only `C:\ProgramData\Manager\caddy-data\caddy\pki\authorities\local\root.crt` through the institution's trusted certificate process. Do not distribute `root.key`.

For an extracted ZIP, edit `manager-install.json` and run `setup.cmd -Unattended -Plan`, followed by `setup.cmd -Unattended`. The offline ZIP defaults to local HTTPS and bundled dependencies.

### Reusing existing PostgreSQL

Use offline setup **2.19.1 or later**. Version 2.19.0 incorrectly replaced unchecked boolean options with their defaults, so unchecking control PostgreSQL installation still produced a port-conflict error. The corrected installer preserves these selections. Uncheck **Install PostgreSQL control database**, enter the existing `postgres` password, and keep the isolated project cluster selected if port 5433 is free. The review screen must say **use existing server**, and preflight must report **Control PostgreSQL plan: Use existing PostgreSQL at 127.0.0.1:5432**.

Setup creates the `server_manager` database and `manager_app` role in that instance. If those names already belong to another installation, use distinct `DbName` and `DbAppUser` values through the ZIP configuration instead of overwriting its credentials. Reusing a database does not change its Windows service startup setting. Verify its existing service is automatic and running after reboot; its name will replace `ManagerPostgreSQLControl` in the acceptance commands below.

## Reboot acceptance check

Complete these checks on the new server while its internet access remains disconnected:

```powershell
Get-Service ManagerPostgreSQLControl,ManagerPostgreSQLApplications |
    Select-Object Name,Status,StartType
Get-ScheduledTask -TaskName 'Manager PM2 Startup'
Get-ScheduledTaskInfo -TaskName 'Manager PM2 Startup'
Get-NetTCPConnection -State Listen -LocalPort 80,443,4000,5432,5433 |
    Select-Object LocalAddress,LocalPort,OwningProcess
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\web\manager\scripts\verify-offline-services.ps1
```

The database services must run automatically. Manager port 4000 and both database ports must listen only on loopback; Caddy handles client-facing HTTPS. Adjust port numbers if configured differently. Reboot during the server's installation window, wait for startup recovery, and run these checks again. Verify login from another institution device, open a deployed application, and deploy another commit from the internal GitLab or Gitea server. An actual reboot on the target remains an acceptance check; process-restart tests on a build host do not replace it.

Node.js, PM2, Git and other runtime files are installed outside the administrator profile under `C:\ProgramData\Manager\tools`. The startup task stores absolute executable paths and a durable PATH; PostgreSQL uses automatic Windows services. Keep `C:\ProgramData\Manager` and the Manager `.env.local` backed up, including encryption keys needed to decrypt stored Git credentials.

## Deploying applications without internet

The offline installer supplies Manager and its host tools. An application's own npm, Composer, pip or Go dependencies must be vendored, available from internal registries, or included in a prepared deployment artifact. GitLab/Gitea can run entirely inside the institution. Configure its HTTPS URL and token in Manager; include the institution CA certificate when applicable. GitHub remains available for connected servers.

Runtime updates and downloading additional runtime versions require a connected release/build process; installing offline does not make public package registries reachable.

## Build a new offline release

On a connected Windows x64 build machine with Node.js and Git:

```powershell
npm run package:windows:offline
```

Formal packaging requires a clean committed checkout. The builder downloads the **pinned** upstream artifacts, verifies hashes (and publisher signatures for Python and Visual C++), builds Manager in an isolated directory with background services disabled, installs the locked production dependencies, and embeds the resulting bundle into a self-contained .NET setup executable. The target does not need .NET installed. Cached publisher artifacts live in ignored `packages/offline-cache`; they are hash-checked before reuse. The final executable receives a SHA-256 receipt and embedded-payload smoke check. Use the existing code-signing parameters for signed distribution.

To update a component, review its upstream release and compatibility, update the pinned URL/hash and any PM2 lockfile, then rebuild and repeat disconnected installation and reboot acceptance tests. Copying a developer's active `node_modules`, `.next`, database, PM2 state or secrets into a release is not part of the build process.
