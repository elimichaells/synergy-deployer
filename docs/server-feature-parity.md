# Host and connected-server functionality audit

Audit for Manager 2.32.2 / agent 1.9.1, starting from Manager 2.31.0 / agent 1.8.0.
The release fixes the verified gaps below; it does not claim universal functional parity.
Production applications, databases and shared proxy configuration are outside the destructive test scope.

| Page/module | Changes and evidence | Still to verify or implement |
| --- | --- | --- |
| Server directory, rename, removal | Existing scoped directory and reviewed removal; PostgreSQL tests cover pending, offline and enrolled records, roles and stale reviews | Browser comparison includes connected, pending, offline and revoked servers; pending removal review is captured |
| Navigation | Shared host/remote infrastructure menu; scoped URL tests and browser navigation through every remote destination; host menu and server-switch resume compared | Account/team/connections remain Manager-wide; browser comparison passes |
| Projects | Server-scoped groups, names, component roles and environment links; real PostgreSQL cross-server and concurrent-change checks | The group-move regression verifies deletion of the empty previous group; a larger live project fixture remains outside this audit |
| App removal | Shared review dialog; typed name, acknowledgement and state-bound review; encrypted management-record archive; deployed remote apps require an agent preservation receipt; active jobs/workers and shared paths block removal. Real isolated Manager PostgreSQL → agent → PM2/Caddy receipt test passes, including rejected forged receipt, preserved process/files/TLS route and untouched peer | No recovery UI for the archive yet |
| App removal preservation | Removal detaches management. Files, running processes, databases, DNS and routes remain. Agent retains detached route/port reservations and cleanup exclusions. Tests cover replay and stale reviews | This is not an uninstall or database deletion operation |
| Processes | Shared app start/restart/stop; selected server routing and authorization tests. Browser confirms shared Caddy restrictions | Windows/Linux PM2 6/7 lifecycle and Manager queue/receipt CI pass. Released-agent startup and live process inventory verified; production processes were not restarted for testing. |
| Memory / staging sleep | Shared app controls and infrastructure workspace; no-restart saves, restart rollback, sleep gateway and server isolation tests pass | Released host/remote pages and remote telemetry verified. Restart and sleep mutations remain isolated lab tests. |
| Environment | Shared separate .env / .env.local editor; encrypted raw contents, comments, precedence and compare-and-save; real PostgreSQL and agent file tests pass; browser save/switch/reload confirms distinct files | Host browser save/switch comparison passes. Atomic host file writes preserve the previous file on interrupted writes; stale edits and links are refused. Windows ReplaceFile and Linux rename are tested. |
| Domains / DNS | Shared application and project domain panel; scoped path routes; conflicting/foreign targets refused; real Caddy HTTP routing test passes. Browser checks LAN address dialog and CA guidance | Full LAN TLS route test and primary-address presentation |
| Logs / console | Shared log/console toggle, bounded output/error tails, polling/clear and role controls. Application operators can use scoped console; cancellation and redaction tests pass | Shared quick-command controls and completion policy; connected-server metadata comes from its own agent. Browser verifies remote Tab completion. Real HTTPS Git authentication passes on Windows/Linux PM2 6/7; ordinary commands never receive Git tokens. Host environment redaction has filesystem tests. |
| Health | Shared readiness path/status/timeout controls used by agent deployment and continuous checks; local redirect and external redirect tests pass | Recheck UI save/read round trip after packaging |
| Deployments / history | Keyset pagination and old deep links; real PostgreSQL history test. Running cancellation restores prior activation; rollback checks exact recorded commit | Real isolated deployment, failed readiness rollback, conflict handling, persistent data and Manager receipt tests pass on Windows/Linux PM2 6/7 |
| Persistent application data | Upload/storage and ignored application-local files move during journaled activation; generated dependencies and fresh .env files remain separate. Tests cover writes during failed readiness, ambiguous copies, crash boundaries and internal links | Larger framework deployments and nested generated link cases |
| Workers | Associated workers stop before data activation and follow the new release; failed activation restores prior launch settings. Real isolated PM2 tests preserve stopped and unrelated workers, follow healthy releases and roll back failed releases | Windows/Linux PM2 6/7 lifecycle CI passes |
| Custom deployment scripts | Shared script editor; line-by-line execution, branch substitution, fail-fast behavior and final dependency audit. Pre/post commands retain host ordering and post-command failure semantics | Host/remote shared script control compared in browser. The production-compiled agent artifact matches the tested source bundle byte-for-byte. |
| Staging promotion | Shared promotion review; server/repository/environment pairing and stale review checks; exact shared-branch commit or merge of the reviewed staging commit. Real HTTPS Git merge/conflict/push tests pass; push happens only after healthy activation. One-deployment security override retains the reviewed promotion and rejects changed staging/production state in PostgreSQL tests | Provider comparison history |
| Git automation | Shared settings; GitHub/Gitea/GitLab signature and provider CRUD tests; exact pushed commits, deduplication, scoped callback deletion and encrypted secrets; PostgreSQL queue tests pass. Signed deliveries through an isolated HTTP listener pass for all three providers, with wrong-server, invalid-signature and disabled-auto-deploy checks | External provider delivery remains outside the fixture test |
| Dependency security gate | Shared setting/findings; pre-install and final-candidate audits; trusted exceptions and explicit expiring overrides; malformed audit output fails closed. Role and receipt tests pass | Host browser error/retry case passes; failed reads keep the disable-gate control unavailable |
| Storage / database detail | Shared list, server inventory, app services and database detail; agent-only transport, encrypted private query results, six offline drivers, multi-service credentials and environment sync. Real PostgreSQL tests cover browsing, bounded SQL, provisioning, rotation, backup/restore, rename/recovery, server create/drop and detached database preservation. MySQL 8.4, MariaDB 11.4, MongoDB 8, SQL Server 2022 and Redis 7 provision/test/rotate/preservation CI passes. Host/remote Data, SQL, Backup, Connection, Settings and server-inventory screens compared; scope changes reset forms and abort stale reads | Real-provider migration matrix and installation matrix pass (see below). Existing MongoDB authentication database options now survive registration, attachment, sharing and environment generation. Private phpMyAdmin now uses an authenticated agent relay with isolated CGI, scoped sessions and no new listener. Real PHP/MySQL tests pass login, SQL browsing, multipart import and authenticated SQL export while preserving the original row. |
| Database account switch | Shared dedicated-user review now queues the selected agent. Real PostgreSQL tests verify limited-role ownership, linked app/worker settings, stopped-process preservation, readiness rollback, stale reviews, interrupted journal recovery and lost-receipt reconciliation. Pending outcomes block conflicting operations and updates. Saved user environment remains separate from generated runtime variables | Real Windows PM2 applications and workers plus Manager receipt pass; recheck after packaging |
| Database move | Reviewed copy between two PostgreSQL servers, limited destination account, data checksums and bigint sequence checks, app/worker switch with readiness rollback, persistent recovery and lost-receipt reconciliation. Two real private PostgreSQL clusters pass on Windows, including changed-owner recovery refusal and protected database deletion after moving and removing all app links. Full Windows PM2 app/worker and Manager receipt test passes (309 seconds). Shared review dialog inspected | Windows/Linux move CI passes; packaged-agent rerun remains |
| Database migrations | Shared reviews, backup/paused-writer acknowledgement, typed target confirmation, scoped history/cancel/activation and recovery. Real Windows Sling/PostgreSQL tests verify staging, target constraint rollback, source preservation, bigint IDs/sequences, lost receipt recovery, cancellation and protected app removal. Remote Sling install/reuse has checksum and custom-path tests | All six real PostgreSQL/MySQL/MariaDB/SQL Server migration directions pass on Linux; shared host/remote review inspected. Full cross-provider content checksums are not implemented. |
| Infrastructure health | Shared charts, history and alerts; browser inspected | Exercise stale/offline states |
| Infrastructure processes / proxy | Shared controls; browser checked configuration viewer and protected shared proxy buttons | Corrected configuration viewer compared; JSON validation and shared Caddy stop/restart restrictions verified |
| Infrastructure disk | Shared scan/cleanup/retention; tests protect current, referenced, detached and linked paths; browser ran synthetic scan only | Real cleanup after successful/failed deployments passes on Windows/Linux PM2 6/7, preserving current processes, application data, the peer site and detached application directories |
| Infrastructure jobs / workers | Shared CRUD/run/logs; OS-correct Go commands, directory prompts and app filters; scoped API and process tests | Updated job and worker forms compared; Go commands follow the selected server OS |
| Infrastructure AI operations | Shared cards and scoped recovery; backend refuses stale evidence, healthy apps and database dependency failures; browser displays recovery blocker | Broader unhealthy disposable app scenario |
| Runtimes / tools | Shared inventory, version selection and service operations; tests for custom paths, service reuse and separate pinned runtimes; browser opened version installer | Real Windows/Linux MongoDB, Windows SQL Server Express and Linux Redis installation/authentication/restart/reuse checks pass. Existing service/data/port checks prevent replacement. Windows Redis and Linux SQL Server remain reuse-only. Windows and Ubuntu private phpMyAdmin installation checks pass, including refusal to overwrite an installation. Official vendor update discovery is implemented. Existing non-versioned service upgrades and private-client replacement still require a maintenance workflow; they are not automated. |
| Agent access / updates | Browser checked version/access/revoke/rename/removal controls. Compatibility tests validate supervised update transport | Manager 2.32.2 and agent 1.9.1 installed successfully. The failed 1.9.0 attempt exercised automatic rollback and preserved the existing enrollment and applications. |
| Global accounts / settings | Intentionally Manager-wide; server selection must not change account ownership or expose local resource actions | Browser confirms account/team/connections are Manager-wide; host defaults are explicitly labelled Manager host. Scoped mutation role tests pass. |

## Evidence boundaries

The browser preview uses synthetic, explicitly isolated fixtures on loopback ports 4013/4014. Screenshots
prove layout and interaction, not real remote service execution. API integration tests use an ephemeral,
password-protected PostgreSQL cluster on a random loopback port. Caddy tests use a separate fixture
configuration. No production application has been removed or redeployed for this audit.

The live lifecycle lab uses a private PM2 daemon, HTTPS Git server and Caddy instance with a private
CA that is not installed into the operating system. Windows Node 24 / PM2 6 tests pass for deployments,
persistent files, environment rollback, workers, merge promotion and application detachment. A second
run includes the real Manager PostgreSQL queue and authenticated removal receipt. These are separate
from the synthetic browser preview and do not prove a reboot or a new-server installation.

Linux and Windows PM2 6/7 lifecycle CI pass, including real native memory counters.
The failure was PowerShell module autoload during ConvertTo-Json inside the daemon;
the counter collector now formats its bounded numeric output using .NET directly. A Windows 8.3 path alias also bypassed the earlier private-pipe preload in a
local compatibility test. Two exact fixture processes were added to the host daemon;
both were identified by their temporary script path and removed. All 36 pre-existing
entries retained their PIDs, status and restart counts. Caddy's configuration hash and
the database service PIDs remained unchanged. Native path resolution and a refusal to
connect to shared PM2 pipes now guard the preload; tests verify the private daemon is
empty before any fixture process is started.

Evidence screenshots are stored locally in the ManagerValidation/server-feature-parity-20261109
folder. Production baseline hashes and process observations are recorded separately, without secrets.
The earlier fresh-install work did not prove a real operating-system reboot: the disposable VMs did
not return a post-reboot receipt, and the user has no spare VM. Do not describe it as verified.

A successful build or a shared component does not establish full functional parity. Complete the
remaining rows and rerun affected integration checks before publishing a parity-complete release.

## Additional evidence on 2026-11-09

- Local regression after console changes: 634 tests, 600 passed, 34 skipped, zero failures.
- Real isolated PostgreSQL console integration: 10 passed, including capability admission, malformed receipts and cancellation. Database connection/authentication integration: 2 passed.
- Service installation run 42718342538: Windows and Ubuntu MongoDB, Windows SQL Server Express, and Ubuntu Redis pass. Redis builds once to avoid parallel dependency archive races; its durable receipt uses the supported raw SAVE command.
- Lifecycle run 42720276245: Windows/Linux PM2 6/7 and Manager receipt all pass, including real HTTPS Git console credentials and cleanup after multiple deployments.
- Console and runtime dialogs reset scope when switching servers. Shared connection forms expose the existing database and MongoDB authentication database; database passwords remain encrypted.
- Browser evidence includes host environment files, host/remote settings, security-gate error/retry, remote completion, global settings scope and unfinished-server removal review.

Manager 2.32.2 and agent 1.9.1 are published and deployed. Automatic updates of existing non-versioned services, private phpMyAdmin replacement and the evidence boundaries above prevent a claim of exact parity for every feature.

## Database browser and update-check evidence

- Manager 2.32 regression: 646 tests, 610 passed, 36 opt-in tests skipped, zero failures. Production build passes; a subsequent type check covers the final history/dialog lifetime cleanup.
- Windows and Ubuntu phpMyAdmin installation jobs pass in run 42730899339. PHP 8.3.36 loads the private INI through PHPRC in CGI mode; command-line checks alone had missed this requirement.
- A real PHP 8.3.36 / private MySQL test passes HTTPS-cookie login, SQL reads, multipart SQL import and authenticated SQL export. The original fixture row remains unchanged. A separate Windows Local Service probe passes.
- The browser displays the imported row. Its Export button returned a successful SQL attachment through the relay, but the in-app browser did not expose download or file-picker events. Transport tests validate those bytes; a browser download artifact was not observed.
- Capability-route tests cover multipart bytes, streamed size limits, download headers, preflight, authorization revocation and root URL normalization. Manager cookies and stored database passwords are not forwarded.
- Tool discovery tests cover release-series filtering, MariaDB identification, cached results and independent vendor failures. Live official-catalog checks returned Composer, PHP, phpMyAdmin, Caddy, PostgreSQL, MySQL, MariaDB, MongoDB and Redis releases.


## Production packaging correction

Manager 2.32.1 installed successfully, preserving all 33 hosted application process IDs,
statuses and restart counts, database service IDs and the Caddy configuration hash.
The remote 1.9.0 agent update rolled back under its supervisor. An isolated test under
the remote Local Service account found a Windows preload with an undefined variable:
Manager's production compiler had transformed the function serialized by the packager.
Source-based startup passed; the actual downloaded artifact failed.

Manager 2.32.2 / agent 1.9.1 embeds the original source bytes. Release validation now
compares the production-compiled packager's output byte-for-byte with the tested source
bundle. An isolated startup test checks IPC and control-plane heartbeats, clean shutdown
and preservation of a separate Caddy site. Final deployment verification passed as recorded below.

## Released package and live verification

- [Release validation](https://github.com/elimichaells/synergy-deployer/actions/runs/42738808943) passed on Node 22 and 24, including fresh installer database initialization, production builds, compiled-agent artifact equality, publisher verification and installer packaging. [Manager 2.32.2](https://github.com/elimichaells/synergy-deployer/releases/tag/v2.32.2) is the stable release; the affected 2.32.1 package was removed from the stable update channel.
- [Windows/Linux PM2 6/7 lifecycle and packaged startup](https://github.com/elimichaells/synergy-deployer/actions/runs/42737894593), [storage operations](https://github.com/elimichaells/synergy-deployer/actions/runs/42737894571), [agent compatibility](https://github.com/elimichaells/synergy-deployer/actions/runs/42737894546) and [full UI regression/build](https://github.com/elimichaells/synergy-deployer/actions/runs/42737894555) all passed on the correction's source tree.
- [Real SSH onboarding](https://github.com/elimichaells/synergy-deployer/actions/runs/42738801916) passed on disposable Windows Server 2025 and Ubuntu 24.04 runners. This does not establish OS reboot recovery.
- Before activation, the agent generated by the verified staged production package passed an isolated startup, control-plane heartbeat, supervisor IPC and graceful-shutdown test. After activation, the live Manager download matched that tested artifact exactly. Agent 1.9.1 then installed successfully and reported all new capabilities in a fresh heartbeat.
- Live browser checks covered the shared infrastructure layout, health/history, processes and shared-proxy restrictions, memory, cleanup, cron and worker forms, AI operations, LAN/public domain choices, runtime update discovery and version selection, console, agent access, import, projects, deployment history, storage registration and migrations. The live application removal review required typed confirmation and acknowledgement; it was cancelled without removing the production application.
- The new remote console completed a read-only command and file-name Tab completion. A remote storage scan completed successfully without removing files. Hosted application PIDs, status and restart counts, database service PIDs and both Caddy configuration hashes matched their pre-update baselines.
- The connected production server had no managed applications during this final check. Actual application detachment, deployment, rollback, database mutations and service installation were tested in isolated labs, not against existing production sites. A pre-existing site response failure remained unchanged and was reported separately.

Browser screenshots and detailed preservation receipts remain local. These checks establish the listed behavior, not universal parity or a successful operating-system reboot.
