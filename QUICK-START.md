# Windows Server Quick Start

## Build a package

For the graphical, self-contained setup executable and its matching online
release assets:

    npm run package:windows:exe

For the PowerShell/ZIP package only:

    powershell -ExecutionPolicy Bypass -File .\scripts\package-manager.ps1

The executable build creates `manager-setup-*.exe`, the versioned Manager ZIP,
and SHA-256 manifests under the packages directory. Sign the EXE with the
organization's Authenticode certificate before external distribution.

## Install on a new server

Recommended: run `ManagerSetup.exe`, choose Online to install `latest` or an
explicit GitHub release tag, complete the server details, and run preflight.
Choose Embedded offline package when the server cannot access GitHub. The
target server does not need .NET or any other preinstalled package.

Unattended alternative:

1. Extract the ZIP.
2. Double-click `setup.cmd` to launch the interactive wizard. It requests
   elevation automatically.
3. For unattended installation, edit `manager-install.json` and preview every
   planned host change:

    .\setup.cmd -Unattended -Plan

4. Run the unattended installation:

    .\setup.cmd -Unattended

Omit -Unattended for the interactive wizard. Passwords may be supplied through
MANAGER_INSTALL_ADMINPASSWORD, MANAGER_INSTALL_DBADMINPASSWORD, and
MANAGER_INSTALL_DBAPPPASSWORD environment variables instead of the JSON file.
Use MANAGER_INSTALL_APPDBADMINPASSWORD when reinstalling or registering an
existing managed application PostgreSQL cluster.

No preinstalled packages or services are required. The installer adds Node.js
LTS, the latest npm supported by that Node release, Git, PM2, Caddy,
PostgreSQL, and selected optional runtimes and database engines. It checks the
host, initializes the
Manager control database, builds the application, validates Caddy, starts PM2
services, configures boot recovery, opens only ports 80 and 443, and writes a
secret-free report with installed component versions to
C:\ProgramData\Manager\install-report.json. A 64-bit Windows Server and an
internet connection are the only host requirements.

The default database layout keeps Manager control data on `127.0.0.1:5432` and
project databases on a separate `ManagerPostgreSQLApplications` Windows service
at `127.0.0.1:5433`. Manager registers the second cluster as the recommended
provider. Projects receive isolated databases and users; automatic project
backups are configured from **Data services**.
