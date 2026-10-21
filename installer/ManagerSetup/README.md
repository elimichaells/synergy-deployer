# Manager Setup executable

`ManagerSetup.exe` is the graphical Windows Server installer. It is a
self-contained .NET 8 WPF application, so the target server does not need the
.NET runtime or SDK.

For Windows Server 2019, use the x64 Desktop Experience installation for the
graphical wizard. The command-line package can be used without the desktop.
Leave `PostgreSqlPackage` as `auto`: setup selects PostgreSQL 17 on Server 2019
and PostgreSQL 18 on Server 2022 or newer, matching the
[EDB-tested Windows platforms](https://www.postgresql.org/download/windows/).

Choose **Institution / local network** or **Public server**, then enter the
server's stable IP address or hostname (without a scheme or port). IPv4,
IPv6, single-label hostnames and domain names are accepted.

| Installation | Address example | HTTPS |
| --- | --- | --- |
| Institution LAN | `192.168.10.20` or `deploy.campus.local` | Local CA; clients must trust its public root certificate |
| Institution LAN using an owned domain | `deploy.institution.edu` | Local CA; public DNS/ACME access is not required |
| Public domain | `deploy.example.com` | Automatic publicly trusted certificate; public DNS and inbound TCP 80/443 required |
| Public IP | `203.0.113.20` | Local CA in this installer; clients must trust its public root certificate |

In local mode, `LocalSubnet` restricts the installer's Windows Firewall rules
to directly connected client networks. Enter comma-separated IP/CIDR ranges
for routed campus networks or VPNs, for example `10.20.0.0/16,192.168.50.0/24`.
Other pre-existing firewall rules are left unchanged. Public mode allows
TCP 80/443 through the installer's rules; the hosting provider's firewall must
also allow the required traffic. Database ports are not opened by setup.

For a hostname, configure DNS or client host mappings to the server; direct
IP access does not require DNS. Manager's internal port (4000 by default), Caddy's
ports (80/443), and enabled database web-client ports (8432/8433) must be free.
Internet access is required for dependencies even with the embedded package.
An internal-network installation is not a fully offline dependency installer.

For local CA HTTPS, the installation report identifies the public root
certificate, normally
`C:\ProgramData\Manager\caddy-data\caddy\pki\authorities\local\root.crt`.
Institution IT should distribute that verified certificate to the trusted root
store on client devices (for example through Group Policy). Transfer only
`root.crt`, never `root.key` or the whole certificate-storage directory.
HTTPS and secure login cookies remain enabled. This wizard does not import
institution-issued certificates; those require a separate Caddy configuration.

After installation, verify HTTPS sign-in and **Storage > Servers > Test
connection** from an intended client. Reboot the server, then check the site
before logging into Windows. The `Manager PM2 Startup` task should have run
after boot with result `0`; both PostgreSQL services should be running. Repeat
sign-in and the database connection test. The trusted root certificate's
SHA-256 hash must be unchanged: Caddy storage is fixed under ProgramData and
is restored for SYSTEM startup. Do not manually start services before checking
automatic recovery. GitHub.com webhooks require an endpoint reachable and
trusted by GitHub; an isolated LAN address/local CA alone does not provide that.

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
