# Consolidating the two Caddy instances on the Server 2019 installation

This repair is for the observed Manager 2.19.1 installation: the automatic Windows service `Caddy` runs `C:\Caddy\caddy.exe run --config C:\Caddy\Caddyfile`, that file defines a disposable test site on port 8081, and Manager's PM2 entry `manager-caddy` runs the bundled executable under its web root. Both instances compete for the administration endpoint on port 2019. Run the repair on the new Server 2019 machine, not on the development host.

Extract the repair ZIP to a dedicated directory on the new server. Keep `repair-manager-caddy.ps1` and `caddy-repair-check.cjs` together. In administrator PowerShell, change into that directory and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\repair-manager-caddy.ps1 -Apply -RetireTestSite
```

With `-RetireTestSite`, the repair keeps the test site out of Manager's configuration. If the previous repair already added `import "C:/Caddy/Caddyfile"`, it removes that exact import. Other configuration is retained. It supports either the running automatic legacy service or the already repaired state with that service stopped/disabled and Manager's Caddy online. Unexpected configurations or port ownership stop the repair before any service changes.

The repair validates the candidate Caddyfile before stopping anything. It stops the previous Caddy instance, starts Manager's bundled Caddy, checks ownership of ports 80, 443 and 2019, and confirms Manager no longer listens on 8081. An unrelated process on 8081 is left alone. It also checks `/login` over HTTPS with certificate validation against Manager's existing local CA. After those checks pass twice, it disables the old Windows service and saves the PM2 startup state. There is a brief web interruption during the switch.

The script backs up both Caddyfiles, the actual running configuration, the service settings, and the saved PM2 process list under an administrator/SYSTEM-only `C:\ProgramData\Manager\Recovery\caddy-<id>` directory. If the switch or verification fails, it attempts to restore the original files, PM2 startup list, previous service owner and startup mode, and running configuration. When undoing a change to an already repaired installation, rollback restores Manager's previous configuration and leaves the legacy service disabled. A rollback failure is explicitly reported with the backup location; do not rerun the fresh installer.

Manager, its database services, stored passwords and encryption keys are not replaced. Old Caddy files remain available for recovery, but Manager no longer imports them in retirement mode. Omitting `-RetireTestSite` retains the previous repair behavior that preserves the port-8081 site; that mode is unnecessary for this disposable test site.

After a successful repair, open `https://192.168.64.90` and log in. Client devices must trust only the public CA certificate at `C:\ProgramData\Manager\caddy-data\caddy\pki\authorities\local\root.crt`; never distribute its private key.

The installation also reported a pending prerequisite reboot. Reboot the new server during its installation window. After startup settles, run from the repair directory:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\repair-manager-caddy.ps1 -VerifyOnly -RetireTestSite

Get-Service postgresql-x64-18,ManagerPostgreSQLApplications,Caddy |
    Select-Object Name,Status,StartType

Get-ScheduledTaskInfo -TaskName 'Manager PM2 Startup'
```

Verification must pass, both PostgreSQL services should be Running/Automatic, and the legacy Caddy service should be Stopped/Disabled. Check Manager login, a deployed application, and a new deployment from the internal Git server after reboot. Port ownership and login checks do not substitute for testing an application's own backend or deployment.
