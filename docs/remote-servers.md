# Remote Windows and Linux servers

Infrastructure → Servers manages several remote machines. Each can host several
applications with independent repositories, commands, environment variables, ports,
hostnames and deployment history. The existing local applications keep their current
engine. Remote applications are accessed through Servers and the Projects → Remote
apps shortcut; local-only database, console, promotion and runtime actions do not
apply to them.

## Network and trust

The agent initiates authenticated HTTPS requests to Manager. A target can be on the
same LAN or in another location behind NAT; it needs no inbound management listener.
Manager itself must be reachable from that target, through institution routing, a
VPN, or a public HTTPS address. A private LAN Manager cannot be reached by another
location merely by enrolling the agent. Credentials never follow HTTP redirects.

Enrollment tokens expire in one hour and can be used by one agent. Agent credentials
are generated and persisted locally before enrollment; Manager stores only their
hashes. Lost enrollment responses can be retried with that same credential. Pending
tokens can be replaced in the UI. Revocation disables subsequent agent requests and
cancels its queue, but does not stop local apps or undo an operation in progress.

For a Manager address using a private CA, give Node the public root certificate with
`NODE_EXTRA_CA_CERTS=/path/to/manager-root.crt` (or the Windows equivalent). Set it
before starting the process and preserve it in the startup service. Never disable
TLS verification. The downloaded agent is available only to signed-in administrators.

## Guided SSH setup

Add a server in **Infrastructure → Servers**, select Windows or Linux, and choose
**Connect with SSH**. Enter its IP/hostname, SSH port, username and password. Supply
a Manager HTTPS address that the target can reach. **Check server identity** obtains
the SSH host fingerprint without password authentication. Compare it with the
server administrator's fingerprint, then select **Install and connect**. Setup pins
that fingerprint before sending credentials. Changing the address or username clears
the accepted identity.

The target must already have SSH/SFTP enabled and reachable from Manager. Across
locations, use institution routing/VPN or an approved gateway mapping. Linux needs
root or sudo with the same password, systemd, and an apt/dnf distribution on x64 or
ARM64. Windows needs x64 and an elevated OpenSSH administrator account. SSH cannot
enable itself remotely when no management connection exists.

Setup downloads Node.js 24, Caddy and (on Windows) portable Git using official
release checksums, installs private PM2 tools, enrolls the agent and configures boot
startup. Manager needs the Node, GitHub release and npm metadata endpoints; the target
needs their download endpoints, npm and its OS package repositories. Institution
proxies or offline environments may require manual enrollment. App-specific runtimes
such as Go, PHP and Composer still need separate installation.

Linux uses `/var/lib/manager-agent`, a dedicated `manager-agent` account and a
systemd unit with permission to bind web ports. Windows uses
`%ProgramData%\ManagerAgent` and a **ManagerRemoteAgent** startup task running as
Local Service, with access to its protected data folder. The administrator login is
used for installation only. Only deploy trusted application code: app processes
share the agent account and are not isolated from one another. A manually provisioned
dedicated account is an option for institution-specific policies. The installers refuse an
existing enrollment/service, an unrelated nonempty data folder, or listeners on
80, 443 or 2029. They do not take over an existing web server.

The SSH password is kept only in request memory, never saved in the database, audit
record, command arguments or setup log. The one-time enrollment token travels in an
account-protected temporary file. Temporary files are removed on normal completion;
if the SSH connection is lost, inspect the reported account's `manager-setup-*`
directory and remove it locally after recovery. Tokens expire after one hour.
Automatic setup is not replayed after a partial enrollment: inspect the target's
service and agent files before retrying. The Manager installer's public local CA is
included automatically when available; another institutional root CA can be supplied
in the form. Certificate verification stays enabled.

The form reports whether a real monitoring heartbeat arrived after installation.
Verify boot startup and one pilot application on each target OS before production
use. Firewall rules, DNS, client trust and databases are separate configuration steps.

## Manual preparation and enrollment

1. Install Node.js 22 or later, Git, PM2 and Caddy on the target. Install Go, PHP,
   Composer or other runtimes needed by your applications separately. These tools
   must be on the **agent account's** PATH. Caddy's executable can instead be set
   using `MANAGER_AGENT_CADDY`.
2. Use a dedicated account and a new, dedicated data directory. For PM2 independent
   of the account's global npm configuration, install it in the agent's tools folder:

   ```sh
   npm install --prefix /var/lib/manager-agent/tools pm2
   ```

   On Windows use `npm install --prefix C:\ManagerAgent\tools pm2`.

3. In Manager, add a server, select its actual OS and download `manager-agent.cjs`.
   Copy the file to the target and run the enrollment command shown in the UI.
   Paste the token at the prompt; do not put it in shell history or a service file.
4. Start the agent with the same absolute `--root` directory. Its first heartbeat
   shows hostname, IP addresses, CPU, available memory, disk capacity and tools.
5. Configure startup at boot. Keep the same account, data folder and environment.

Example Linux systemd unit (create the account and directories first; put the
downloaded script at `/opt/manager-agent/manager-agent.cjs`):

```ini
[Unit]
Description=Manager remote server agent
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=manager-agent
Group=manager-agent
Environment=PATH=/usr/local/bin:/usr/bin:/bin
WorkingDirectory=/var/lib/manager-agent
ExecStart=/usr/bin/node /opt/manager-agent/manager-agent.cjs run --root /var/lib/manager-agent
Restart=on-failure
RestartSec=10
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
```

Enroll as this same account. The capability permits Caddy to bind 80/443 without
running the agent as root. Enable the saved unit with `systemctl enable --now
manager-agent`. Add `Environment=NODE_EXTRA_CA_CERTS=...` if needed. A service stop
also stops processes in its systemd group; PM2 resurrects saved apps when it restarts.

On Windows, use Task Scheduler with an **At startup** trigger, the dedicated agent
account, **Run whether user is logged on or not**, and **Do not start a new instance**.
The program is the absolute path to `node.exe`; arguments are the absolute script
path followed by `run --root C:\ManagerAgent`. Use the same account that enrolled
and installed tools. Configure restart on failure and remove any execution time
limit. The agent removes inherited ACLs from its new data folder and grants its
account, SYSTEM and Administrators access. If using a private CA or a custom Caddy
path, supply those environment settings through the service account or a launcher.
Verify both app availability and heartbeat after a reboot.

The agent uses its own PM2 home under the data folder. It restores its saved apps and
Caddy when starting. It does not adopt existing apps or overwrite an existing Caddy
installation. Ports 80/443 must be available. Its Caddy admin endpoint is loopback
only on 2029, and it refuses to reload a different installation on that port.

## Multiple applications and Caddy

Create each application on its server with a different backend port and hostname.
For example, the same machine can serve:

| App | Backend | Readable address | Optional IP address |
| --- | --- | --- | --- |
| Library | 127.0.0.1:3100 | https://library.campus.example.edu | https://192.168.10.20:8443 |
| Records | 127.0.0.1:3200 | https://records.campus.example.edu | https://192.168.10.20:8444 |

Caddy accepts all hostname requests on 443 and routes them to the correct app.
An IP alone cannot select among apps on the same host, so each optional IP route has
its own HTTPS port. IPv4 and IPv6 addresses are supported. Backend ports and IP
listener ports cannot collide with another registered app on the same server.

**LAN:** choose LAN certificate mode. Manager renders `tls internal` even if your
internal name is under a real institution domain. Create an internal DNS A/AAAA
record pointing to the server's LAN IP. Once Caddy creates its local CA, the next
heartbeat makes **Download root CA** available. Distribute that public certificate
to clients through Group Policy, MDM or the appropriate OS/browser trust store.
Each server has its own CA in this version. Clients need both DNS resolution and
trust; Caddy does not configure the institution's DNS or client devices. Internal
certificate issuance works without internet, but cloning and builds still need
access to repositories and dependency registries or their institution mirrors.

**WAN:** choose WAN certificate mode and a public domain. Set public DNS A/AAAA
records to the correct server/gateway, allow/forward TCP 80 and 443 and allow Caddy
outbound access to public certificate authorities. Caddy manages public certificate
issuance and renewal. For a WAN hostname accessed from inside the institution, use
split DNS to the LAN address or suitable hairpin NAT. Optional IP routes always use
the local CA, independently of the hostname certificate mode.

**Access control:** LAN certificate mode chooses the issuer; it is not a firewall.
Scope inbound rules to the required institution networks for LAN-only sites. Permit
only the required web/IP HTTPS ports. Keep application ports and Caddy's admin port
private. Configure application start commands to bind to loopback; the agent supplies
HOST/HOSTNAME but an application must honor them. The Next.js preset binds explicitly.
This version does not change OS firewall rules, gateway forwarding, DNS or VPNs.

## Deployment and recovery

Administrators register servers, edit app configuration and revoke access. Operators
can deploy and cancel jobs that are still queued. Viewers can inspect status and
deployment logs. These follow the workspace's existing global roles; there is no
per-server tenancy or isolation between untrusted application authors.

Public HTTPS Git repositories work without credentials. Private repositories use
an existing Git connection with host validation and its optional CA. Manager encrypts
app environments and job snapshots at rest; Git credentials are sent only to the
assigned agent and supplied to Git through its environment, never clone URLs or
arguments. Build processes receive a reduced environment without agent credentials.
Build output is redacted in the agent and again in Manager. As with other deployment
tools, transformed/encoded secrets printed by application code cannot all be detected.

Each deployment clones a fresh release, writes environment files, installs/builds,
then journals the previous state before briefly stopping that app. It starts the
candidate, requires HTTP 2xx on the configured loopback health path, validates and
loads Caddy, and persists the new release. The app's HTTP health and loaded routes
are checked; successful deployment does not attest to public DNS, client CA trust,
or completed asynchronous public certificate issuance. Other apps remain running.

Only one deployment executes per server; different servers can deploy independently.
Queued jobs survive Manager restarts and offline servers. Once claimed, a job is
never reassigned or automatically replayed. The agent retains a local journal and
retries reports after connection loss; reports have monotonic sequence numbers.
If the agent restarts in mid-deployment, it attempts to restore the journaled old
app and routes and reports failure. Inspect any rollback failure in its log. Do not
delete the data directory or journal to retry a running job.

App settings are snapshots: edits affect the next deployment. The previous code and
Caddy routes are restored if activation fails. Rollback cannot reverse database
migrations, external effects of build scripts or user data changes. Keep persistent
uploads/storage outside release folders. Environment variables are encrypted in
Manager but exist in protected files on the target. Treat its data directory and
backups as sensitive. Only deploy trusted code: scripts run as the agent's OS account
and can access resources permitted to that account.

Monitoring currently shows the latest sample and PM2 process status, not historical
graphs or continuous application readiness checks. Release directories are retained
for inspection; monitor disk space and archive old releases deliberately. Webhooks,
manual release selection/rollback, database provisioning, app-specific runtime installation,
per-server roles and shared institutional CAs remain later work. The agent's PM2 and
application log files stay under its protected data folder.

References: [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https),
[Caddy configuration options](https://caddyserver.com/docs/caddyfile/options),
[PM2 ecosystem configuration](https://pm2.keymetrics.io/docs/usage/application-declaration/),
[Node child process behavior](https://nodejs.org/api/child_process.html),
[Windows task service accounts](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtaskprincipal).
