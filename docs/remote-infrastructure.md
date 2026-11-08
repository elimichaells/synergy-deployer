# Remote infrastructure workspaces

Manager 2.28 and agent 1.6 use the same Health, Processes, Domains & DNS,
runtime inventory, terminal, and update-version components as the Manager host.
Each remote adapter uses a server-scoped API. Switching servers never changes
an operation's target to the Manager host.

Update the remote agent under **Agent access & updates** after updating Manager.
Older agents keep reporting inventory; new controls require the
`remote-infrastructure-v1` capability and a current heartbeat. Disconnected
servers show unknown status and reject new operations.

## Health and processes

The agent checks deployed applications on loopback, requiring HTTP 2xx from the
configured health path. Stopped applications are paused, not healthy samples.
Manager retains seven days of sampled readiness history and applies the same
disk, memory, restart, log-size, and incident recovery policy as the host.
The remote scope includes Manager-managed apps, the agent's application disk,
server memory, and Caddy availability. Host-only backup/security integrations
are not inferred from a remote heartbeat.

Start, stop, and restart target only registered applications in the agent's
private PM2 registry. Successful changes save the registry for reboot. Jobs
are serialized with deployments, service installation, and agent updates,
expire before execution if delayed, and are never automatically replayed after
an interrupted claim. The UI waits for an acknowledgement before reporting
success.

Shared Caddy installations retain their existing sites and source configuration.
Reload reconciles Manager-owned routes using the existing conditional-update
guard. Start, stop, and restart are disabled for a shared proxy. Administrators
can inspect and validate its configuration from the same Processes screen.

## Domains and runtimes

Cloudflare connections are shared Manager settings. Application selection,
domain records, route jobs, and removal are scoped to the selected server.
Manual DNS mode never calls Cloudflare. Existing unmanaged DNS records are
never overwritten. A new DNS record is created only after the remote agent
confirms its route. Interrupted operations retain their record and error for
Sync/recovery. Removing a managed domain waits for route acknowledgement and
checks DNS ownership before deleting the record. Zone SSL changes are
zone-wide, as described by the shared confirmation dialog.

Runtime install, version, and configuration buttons open a service sheet on
the selected server. SSH credentials remain operation-scoped. The service
inspection, fingerprint verification, custom paths, reviewed plan, and existing
database/site preservation checks still apply. Project runtime versions remain
separate from the host defaults.

## Console and agent updates

The shared terminal supports command history, copy, clear, cancellation, and
working-directory changes. Remote commands run as the agent account and retain
their output in audited operation history. Application consoles remain inside
the deployed release; server consoles start in the agent's private console
directory. Windows uses PowerShell and Linux uses Bash.

Agent updates use the existing supervisor and rollback protocol. They update
the agent, not Manager itself or installed database engines. Enrollment,
application processes, and existing service settings remain in place.
