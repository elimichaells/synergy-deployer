# Consolidating the two Caddy instances on the Server 2019 installation

This repair is for the observed Manager 2.19.1 installation: the automatic Windows service `Caddy` runs `C:\Caddy\caddy.exe run --config C:\Caddy\Caddyfile`, that file defines the existing site on port 8081, and Manager's PM2 entry `manager-caddy` runs the bundled executable under its web root. Both instances compete for the administration endpoint on port 2019.

Extract the repair ZIP to a dedicated directory on the new server. Keep `repair-manager-caddy.ps1` and `caddy-repair-check.cjs` together. In administrator PowerShell, change into that directory and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\repair-manager-caddy.ps1 -Apply
```

The repair validates the combined Caddyfile before stopping anything. It preserves the old port-8081 configuration with `import "C:/Caddy/Caddyfile"` in Manager's Caddyfile. It then stops the old service, restarts only Manager's Caddy, and checks that PM2 owns ports 80, 443, 2019 and 8081. It also checks `/login` over HTTPS with certificate validation against Manager's existing local CA. After those checks pass twice, it disables the old Windows service and saves the PM2 startup state. There is a brief web interruption during the switch.

The script backs up both Caddyfiles, the actual running legacy configuration, the service settings, and the saved PM2 process list under an administrator/SYSTEM-only `C:\ProgramData\Manager\Recovery\caddy-<id>` directory. If the switch or verification fails, it attempts to restore the original files, PM2 startup list, legacy service startup mode, and running legacy configuration. A rollback failure is explicitly reported with the backup location; do not rerun the fresh installer.

Manager, its database services, stored passwords and encryption keys are not replaced. Keep `C:\Caddy\Caddyfile` and any files it imports: Manager now includes that configuration. The existing site's route configuration is preserved, but its application response must still be checked from a client.

After a successful repair, open `https://192.168.64.90`, log in, and check the existing port-8081 site. Client devices must trust only the public CA certificate at `C:\ProgramData\Manager\caddy-data\caddy\pki\authorities\local\root.crt`; never distribute its private key.

The installation also reported a pending prerequisite reboot. Reboot the new server during its installation window. After startup settles, run from the repair directory:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\repair-manager-caddy.ps1 -VerifyOnly

Get-Service postgresql-x64-18,ManagerPostgreSQLApplications,Caddy |
    Select-Object Name,Status,StartType

Get-ScheduledTaskInfo -TaskName 'Manager PM2 Startup'
```

Verification must pass, both PostgreSQL services should be Running/Automatic, and the legacy Caddy service should be Stopped/Disabled. Check Manager login, the port-8081 site, a deployed application, and a new deployment from the internal Git server after reboot. Port ownership and login checks do not substitute for testing an application's own backend or deployment.
