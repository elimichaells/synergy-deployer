# Host and connected-server functionality audit

Working audit against Manager 2.31.0 / agent 1.8.0. This branch is not a completed parity release.
Production applications, databases and shared proxy configuration are outside the destructive test scope.

| Page/module | Changes and evidence | Still to verify or implement |
| --- | --- | --- |
| Server directory, rename, removal | Existing scoped directory and reviewed removal; PostgreSQL tests cover pending, offline and enrolled records, roles and stale reviews | Browser comparison of all directory states |
| Navigation | Shared host/remote infrastructure menu; scoped URL tests and browser navigation through every remote destination; host menu and server-switch resume compared | Global settings and account navigation |
| Projects | Server-scoped groups, names, component roles and environment links; real PostgreSQL cross-server and concurrent-change checks | Empty old group navigation after moving an app |
| App removal | Shared review dialog; typed name, acknowledgement and state-bound review; encrypted management-record archive; deployed remote apps require an agent preservation receipt; active jobs/workers and shared paths block removal. Real isolated Manager PostgreSQL → agent → PM2/Caddy receipt test passes, including rejected forged receipt, preserved process/files/TLS route and untouched peer | No recovery UI for the archive yet |
| App removal preservation | Removal detaches management. Files, running processes, databases, DNS and routes remain. Agent retains detached route/port reservations and cleanup exclusions. Tests cover replay and stale reviews | This is not an uninstall or database deletion operation |
| Processes | Shared app start/restart/stop; selected server routing and authorization tests. Browser confirms shared Caddy restrictions | Real isolated PM2 lifecycle through the complete Manager/agent transport |
| Memory / staging sleep | Shared app controls and infrastructure workspace; no-restart saves, restart rollback, sleep gateway and server isolation tests pass | Recheck full interaction with the released agent |
| Environment | Shared separate .env / .env.local editor; encrypted raw contents, comments, precedence and compare-and-save; real PostgreSQL and agent file tests pass; browser save/switch/reload confirms distinct files | Host browser comparison and independent host filesystem error tests |
| Domains / DNS | Shared application and project domain panel; scoped path routes; conflicting/foreign targets refused; real Caddy HTTP routing test passes. Browser checks LAN address dialog and CA guidance | Full LAN TLS route test and primary-address presentation |
| Logs / console | Shared log/console toggle, bounded output/error tails, polling/clear and role controls. Application operators can use scoped console; cancellation and redaction tests pass | Quick-command/autocomplete/Git-auth comparison; browser host comparison. Host environment-value log redaction now has filesystem tests. |
| Health | Shared readiness path/status/timeout controls used by agent deployment and continuous checks; local redirect and external redirect tests pass | Recheck UI save/read round trip after packaging |
| Deployments / history | Keyset pagination and old deep links; real PostgreSQL history test. Running cancellation restores prior activation; rollback checks exact recorded commit | Isolated complete end-to-end deployment with real process supervisor |
| Persistent application data | Upload/storage and ignored application-local files move during journaled activation; generated dependencies and fresh .env files remain separate. Tests cover writes during failed readiness, ambiguous copies, crash boundaries and internal links | Larger framework deployments and nested generated link cases |
| Workers | Associated workers stop before data activation and follow the new release; failed activation restores prior launch settings. Real isolated PM2 tests preserve stopped and unrelated workers, follow healthy releases and roll back failed releases | Cross-platform PM2 6/7 lifecycle CI added |
| Custom deployment scripts | Shared script editor; line-by-line execution, branch substitution, fail-fast behavior and final dependency audit. Pre/post commands retain host ordering and post-command failure semantics | Browser check of the shared control and production package validation |
| Staging promotion | Shared promotion review; server/repository/environment pairing and stale review checks; exact shared-branch commit or merge of the reviewed staging commit. Real HTTPS Git merge/conflict/push tests pass; push happens only after healthy activation. One-deployment security override retains the reviewed promotion and rejects changed staging/production state in PostgreSQL tests | Provider comparison history |
| Git automation | Shared settings; GitHub/Gitea/GitLab signature and provider CRUD tests; exact pushed commits, deduplication, scoped callback deletion and encrypted secrets; PostgreSQL queue tests pass. Signed deliveries through an isolated HTTP listener pass for all three providers, with wrong-server, invalid-signature and disabled-auto-deploy checks | External provider delivery remains outside the fixture test |
| Dependency security gate | Shared setting/findings; pre-install and final-candidate audits; trusted exceptions and explicit expiring overrides; malformed audit output fails closed. Role and receipt tests pass | Browser error/retry case |
| Storage / database detail | Shared list, server inventory, app services and database detail; agent-only transport, encrypted private query results, six offline drivers, multi-service credentials and environment sync. Real PostgreSQL tests cover browsing, bounded SQL, provisioning, rotation, backup/restore, rename/recovery, server create/drop and detached database preservation. MySQL 8.4, MariaDB 11.4, MongoDB 8, SQL Server 2022 and Redis 7 provision/test/rotate/preservation CI passes. Host/remote Data, SQL, Backup, Connection, Settings and server-inventory screens compared; scope changes reset forms and abort stale reads | Migrations remain unwired; complete browser comparison and installation coverage |
| Database account switch | Shared dedicated-user review now queues the selected agent. Real PostgreSQL tests verify limited-role ownership, linked app/worker settings, stopped-process preservation, readiness rollback, stale reviews, interrupted journal recovery and lost-receipt reconciliation. Pending outcomes block conflicting operations and updates. Saved user environment remains separate from generated runtime variables | Real Windows PM2 applications and workers plus Manager receipt pass; recheck after packaging |
| Database move | Reviewed copy between two PostgreSQL servers, limited destination account, data checksums and bigint sequence checks, app/worker switch with readiness rollback, persistent recovery and lost-receipt reconciliation. Two real private PostgreSQL clusters pass on Windows, including changed-owner recovery refusal and protected database deletion after moving and removing all app links. Full Windows PM2 app/worker and Manager receipt test passes (309 seconds). Shared review dialog inspected | Windows/Linux move CI and packaged-agent rerun |
| Infrastructure health | Shared charts, history and alerts; browser inspected | Exercise stale/offline states |
| Infrastructure processes / proxy | Shared controls; browser checked configuration viewer and protected shared proxy buttons | Repeat configuration viewer after fixture correction |
| Infrastructure disk | Shared scan/cleanup/retention; tests protect current, referenced, detached and linked paths; browser ran synthetic scan only | Real isolated cleanup after multiple deployments |
| Infrastructure jobs / workers | Shared CRUD/run/logs; OS-correct Go commands, directory prompts and app filters; scoped API and process tests | Browser recheck of updated forms |
| Infrastructure AI operations | Shared cards and scoped recovery; backend refuses stale evidence, healthy apps and database dependency failures; browser displays recovery blocker | Broader unhealthy disposable app scenario |
| Runtimes / tools | Shared inventory, version selection and service operations; tests for custom paths, service reuse and separate pinned runtimes; browser opened version installer | End-to-end isolated installation matrix for all supported tools |
| Agent access / updates | Browser checked version/access/revoke/rename/removal controls. Compatibility tests validate supervised update transport | Rebuild and install the updated agent; recovery check |
| Global accounts / settings | Intentionally Manager-wide; server selection must not change account ownership or expose local resource actions | Browser navigation and role check |

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

Linux PM2 6/7 lifecycle CI passes. Windows PM2 6 passed before the counter change;
the latest Windows PM2 6/7 CI runs time out in native PowerShell counters. A focused
real-daemon counter check now runs before the lifecycle test. This remains unresolved. A Windows 8.3 path alias also bypassed the earlier private-pipe preload in a
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
