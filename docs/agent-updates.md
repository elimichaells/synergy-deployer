# Remote agent updates

Open a connected server, choose **Server access → Agent updates**, and click
**Update agent**. Only administrators can start or cancel an update; operators and
viewers can inspect its version and progress. **Check version** compares the last
reported agent version with the version bundled in this Manager installation.
Update Manager first to receive newer agent releases. Downgrades and reinstalling
the same version are not offered.

The agent needs outbound HTTPS to Manager only. Agent updates do not need GitHub,
npm or other internet access on the remote server. An offline Manager release
includes the agent package too. TLS verification and institution CA trust remain
enabled. The authenticated connection delivers an immutable package with its
SHA-256 digest; the supervisor verifies the digest, version, syntax and protocol
before activation. This is distribution through your trusted Manager, not a
separate remote-agent code-signing infrastructure.

## What an update changes

The stable `manager-agent-supervisor.cjs` process owns the update lifecycle. The
Windows startup task or Linux systemd service starts that supervisor, which starts
the replaceable `manager-agent.cjs` child. Updates replace only that child script.
The service, PM2 daemon, Caddy and applications are not stopped or reconfigured.
The supervisor itself is not replaced by this protocol; a future incompatible
supervisor release requires a separate maintenance upgrade.

The server's active deployment finishes first. New application claims pause while
an agent update is queued, installing or needs recovery. Queued application work
stays queued. The local deployment journal must also finish reporting before an
update can start. Closing the browser or restarting Manager does not cancel it.

The supervisor retains the previous agent with a checksum in `.agent-updates` under
the existing agent data directory. Before activation, it records a durable recovery
journal. A candidate must send successful authenticated Manager heartbeats over a
15-second observation period with the expected version and unchanged reported app
states. Enrollment, app registry and Caddy configuration are checked for unexpected
changes. It never runs enrollment, app builds, database migrations or PM2 restarts.

Failure to start, reconnect or preserve application state restores the previous
agent. Recovery also runs after a supervisor or server restart during activation.
If Manager is unreachable, restoration happens locally and the result waits for a
confirmed heartbeat before it is acknowledged. A rollback that cannot be verified
shows **Recovery needs attention** and keeps new application claims paused. Inspect
the supervisor's service logs and `.agent-updates/state.json`; do not delete that
journal, its backup or the enrollment to clear the warning.

## One-time upgrade for existing agents

Agents installed before 1.2.0 do not have a supervisor and cannot install their own
first updater. They show **One-time setup needed**. New SSH installations include
the supervisor automatically. Manually installed 1.2.0 agents must also run through
the supervisor to advertise update support.

Perform this initial service migration in a maintenance window. A legacy Linux
service stop can stop PM2, Caddy and its applications too, so this one-time migration
may briefly interrupt hosted applications. Subsequent button-driven updates do not
stop the service. Have an administrator who knows the server's startup configuration
perform the following steps:

1. Download **Agent** and **Supervisor** from this server's **Agent updates** panel.
   Save them to a temporary folder, not over the running files. Read the existing
   service/task command and identify its data root, account, Node executable, PATH,
   custom Caddy executable and `NODE_EXTRA_CA_CERTS` settings.
2. In Manager, cancel queued application jobs and allow any running job to finish.
   Prevent other operators from scheduling work during this maintenance window.
   Confirm `current-job.json` is absent from the existing data root. Do not continue
   with an unresolved deployment journal. Back up the old script and startup
   definition outside the filenames about to be replaced.
3. Stop the existing agent through its service/task manager. Keep the current
   enrollment and application data in place. Copy both downloaded files into the
   **existing data root**, beside `agent.json`. Keep the existing directory ACLs or
   ownership; the agent account must be able to read/write its own scripts and
   `.agent-updates` directory. Do not run the enrollment command again.
4. Change only the startup program's script/arguments to start the supervisor, as
   shown below. Keep the same account, data root, working directory, PATH, CA and
   Caddy environment, startup trigger and restart policy. Start it again.
5. Confirm the original server reconnects, reports agent 1.2.0 and no longer shows
   **One-time setup needed**. Check its applications and their HTTPS routes. If the
   supervisor cannot start, stop it, restore the saved script and original startup
   definition, then start the original agent. Do not create another server record.

### Windows

SSH-installed agents use the `ManagerRemoteAgent` scheduled task, LocalService
account (`S-1-5-19`) and `C:\ProgramData\ManagerAgent`. Preserve that identity. The
task invokes `start-agent.ps1`, which already sets the tool and CA environment.
Replace only its final Node invocation with:

```powershell
& (Join-Path $agentRoot 'tools\node\node.exe') (Join-Path $agentRoot 'manager-agent-supervisor.cjs') --root $agentRoot
exit $LASTEXITCODE
```

For a custom scheduled task, keep its existing Node path and account; its arguments
become `"<existing-data-root>\manager-agent-supervisor.cjs" --root "<existing-data-root>"`.
Use **Do not start a new instance**, restart on failure and no execution time limit.
Do not run the supervisor under your interactive Administrator account when the
existing applications belong to another service account.

### Linux

For the default SSH-installed `manager-agent.service`, set `ExecStart` to:

```ini
ExecStart=/var/lib/manager-agent/tools/node/bin/node /var/lib/manager-agent/manager-agent-supervisor.cjs --root /var/lib/manager-agent
```

For a systemd drop-in, include an empty `ExecStart=` before the new value to reset
the previous command. Keep User/Group, capabilities, PATH and CA environment from
the existing unit. Run `sudo systemctl daemon-reload`, then start the service and
inspect `journalctl -u manager-agent.service`. For a custom installation, substitute
the existing Node path and data root. There is no need to weaken systemd KillMode;
normal agent updates keep the service process alive.

## Recovery boundaries

Application files, databases, secrets, PM2 data and Caddy certificate storage are
never deleted or replaced by the updater. The update backup is of the agent script;
it is not a substitute for application or database backups. Application checking
uses the agent's reported process states and proxy health, not an end-to-end browser
test of every application. If protected configuration changes unexpectedly, recovery
stops for local inspection rather than overwriting potentially valid application data.

Technical reference for legacy Linux service stop behavior:
[systemd.kill](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html).
