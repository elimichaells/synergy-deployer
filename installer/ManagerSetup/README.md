# Manager Setup executable

`ManagerSetup.exe` is the graphical Windows Server installer. It is a
self-contained .NET 8 WPF application, so the target server does not need the
.NET runtime or SDK.

For Windows Server 2019, use the x64 Desktop Experience installation for the
graphical wizard. The command-line package can be used without the desktop.
Leave `PostgreSqlPackage` as `auto`: setup selects PostgreSQL 17 on Server 2019
and PostgreSQL 18 on Server 2022 or newer, matching the
[EDB-tested Windows platforms](https://www.postgresql.org/download/windows/).

Before running setup, choose the public domain, point its DNS at the server,
and allow inbound TCP 80/443 in the hosting provider's firewall. Setup adds the
Windows Firewall rules. Manager's internal port (4000 by default), Caddy's
ports (80/443), and enabled database web-client ports (8432/8433) must be free.
Internet access is required for dependencies even with the embedded package.

Setup is for a new installation. Preflight rejects a destination containing
`.env.local` so existing encryption keys and stored credentials cannot be
replaced. If an installation is interrupted after that file is created, keep
the file and database intact and diagnose the logged failure before recovery;
do not delete the file to force a reinstall. The installer now records the
absolute runtime paths used by the SYSTEM startup task, and starts Manager
from its installed directory on `127.0.0.1`.

The wizard supports two package sources:

- Online: downloads `manager-windows-*.zip` and its matching
  `.sha256.json` asset from a versioned GitHub Release.
- Offline: extracts the same checksummed package embedded in the executable.

The wizard passes passwords to the PowerShell provisioning engine through
child-process environment variables, keeping them out of its command line and
temporary JSON configuration. The PostgreSQL package installer receives its
administrator password through Chocolatey's package parameters. Provisioning
passwords are removed from the environment before starting PM2 services.

Build both release artifacts from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-manager-exe.ps1
```

The build emits the setup EXE, Manager ZIP, and SHA-256 manifests in `packages`.
If .NET 8 is not installed, the build script downloads a private SDK under the
current user's local application-data directory; it does not install a system
runtime or service. The generated executable validates its embedded payload as
part of every build.

Before external distribution, sign `ManagerSetup.exe` with the organization's
Authenticode certificate and upload all four generated files to the same GitHub
Release. Tag pushes run `.github/workflows/manager-release.yml` to build and
publish these assets automatically.

To sign during packaging, import the code-signing certificate into the current
user or local-machine certificate store and pass its thumbprint:

```powershell
.\scripts\package-manager-exe.ps1 `
  -CodeSigningCertificateThumbprint "CERTIFICATE_THUMBPRINT"
```
