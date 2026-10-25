# Disposable SSH onboarding lab

Run **Actions → SSH onboarding lab → Run workflow** to test without owning a
Windows or Linux test server. The workflow provisions fresh GitHub-hosted Windows
Server 2025 and Ubuntu 24.04 runners, one at a time (Windows first).

Each runner creates a temporary SSH administrator and a separate PostgreSQL
database. The production `setupServerSsh` implementation connects to real OpenSSH
over loopback, transfers the production installer using SFTP, downloads verified
tools, installs the agent and registers its scheduled task or systemd service.
The agent calls the real Manager agent API route handlers over HTTPS using an
ephemeral trusted lab CA. No Manager functions, SSH transport, installer commands,
database queries or agent responses are mocked.

The lab verifies host-key pinning, rejected credentials, enrollment, reported
tools and monitoring, credential handling, staging cleanup, service identity,
startup registration and a fresh heartbeat after a service restart. Sanitized
results are stored in the workflow summary and short-lived artifacts.

These scripts deliberately refuse ordinary hosts and installed Manager checkouts.
They must never be run on the production Manager. Passwords and certificates are
generated per run; no production credentials or servers are used. The GitHub
runners are disposed of when the jobs finish.

This covers the real SSH installation engine and agent APIs, not browser sign-in,
an institution's network/firewall policy, rebooting a machine, ARM64, older Windows
versions, or deploying applications through Caddy. The existing remote-agent tests
cover application deployment and rollback logic separately. A pending server
record in the production UI is only metadata; it does not provision a computer.

Runner prerequisites follow the official [Windows runner image](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md)
and [Win32 OpenSSH installation instructions](https://github.com/PowerShell/Win32-OpenSSH/wiki/Install-Win32-OpenSSH).
