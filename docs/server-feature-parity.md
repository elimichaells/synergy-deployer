# Host and connected-server functionality audit

Working audit against Manager 2.31.0 / agent 1.8.0. This branch is not a completed parity release.
Production applications, databases and shared proxy configuration are outside the destructive test scope.

| Page/module | Changes and evidence | Still to verify or implement |
| --- | --- | --- |
| Server directory, rename, removal | Existing scoped directory and reviewed removal; PostgreSQL tests cover pending, offline and enrolled records, roles and stale reviews | Browser comparison of all directory states |
| Navigation | Shared host/remote infrastructure menu; scoped URL tests and browser navigation through every remote destination | Host browser comparison |
| Projects | Server-scoped groups, names, component roles and environment links; real PostgreSQL cross-server and concurrent-change checks | Empty old group navigation after moving an app |
| App removal | Shared review dialog; typed name, acknowledgement and state-bound review; encrypted management-record archive; deployed remote apps require an agent preservation receipt; active jobs/workers and shared paths block removal | Full deployed-agent receipt test with real PM2; no recovery UI for the archive yet |
| App removal preservation | Removal detaches management. Files, running processes, databases, DNS and routes remain. Agent retains detached route/port reservations and cleanup exclusions. Tests cover replay and stale reviews | This is not an uninstall or database deletion operation |
| Processes | Shared app start/restart/stop; selected server routing and authorization tests. Browser confirms shared Caddy restrictions | Real isolated PM2 lifecycle through the complete Manager/agent transport |
| Memory / staging sleep | Shared app controls and infrastructure workspace; no-restart saves, restart rollback, sleep gateway and server isolation tests pass | Recheck full interaction with the released agent |
| Environment | Shared separate .env / .env.local editor; encrypted raw contents, comments, precedence and compare-and-save; real PostgreSQL and agent file tests pass; browser save/switch/reload confirms distinct files | Host browser comparison and independent host filesystem error tests |
| Domains / DNS | Shared application and project domain panel; scoped path routes; conflicting/foreign targets refused; real Caddy HTTP routing test passes. Browser checks LAN address dialog and CA guidance | Full LAN TLS route test and primary-address presentation |
| Logs / console | Shared log/console toggle, bounded output/error tails, polling/clear and role controls. Application operators can use scoped console; cancellation and redaction tests pass | Quick-command/autocomplete/Git-auth comparison; host log redaction; browser host comparison |
| Health | Shared readiness path/status/timeout controls used by agent deployment and continuous checks; local redirect and external redirect tests pass | Recheck UI save/read round trip after packaging |
| Deployments / history | Keyset pagination and old deep links; real PostgreSQL history test. Running cancellation restores prior activation; rollback checks exact recorded commit | Isolated complete end-to-end deployment with real process supervisor |
| Persistent application data | Upload/storage and ignored application-local files move during journaled activation; generated dependencies and fresh .env files remain separate. Tests cover writes during failed readiness, ambiguous copies, crash boundaries and internal links | Larger framework deployments and nested generated link cases |
| Workers | Associated workers stop before data activation and follow the new release; failed activation restores prior launch settings; intentionally stopped and unrelated workers are preserved in tests | Real PM2 worker test |
| Custom deployment scripts | Shared script editor; line-by-line execution, branch substitution, fail-fast behavior and final dependency audit. Pre/post commands retain host ordering and post-command failure semantics | Browser check of the shared control and production package validation |
| Staging promotion | Shared promotion review; server/repository/environment pairing and stale review checks; exact shared-branch commit or merge of the reviewed staging commit. Agent pushes only after accepted healthy activation; push failure leaves a visible warning | Real Git merge/conflict/push integration; provider comparison history; one-deployment security override for a failed promotion |
| Git automation | Shared settings; GitHub/Gitea/GitLab signature and provider CRUD tests; exact pushed commits, deduplication, scoped callback deletion and encrypted secrets; PostgreSQL queue tests pass | Full signed provider delivery against isolated HTTP service |
| Dependency security gate | Shared setting/findings; pre-install and final-candidate audits; trusted exceptions and explicit expiring overrides; malformed audit output fails closed. Role and receipt tests pass | Browser error/retry case |
| Storage / database detail | Audit confirms remote storage still only shows connection summaries/guided setup; host explorer, backups, restore, move, rename and multi-service controls are not wired remotely | Implement server-scoped database transport and shared complete screens; do not route to host APIs |
| Infrastructure health | Shared charts, history and alerts; browser inspected | Exercise stale/offline states |
| Infrastructure processes / proxy | Shared controls; browser checked configuration viewer and protected shared proxy buttons | Repeat configuration viewer after fixture correction |
| Infrastructure disk | Shared scan/cleanup/retention; tests protect current, referenced, detached and linked paths; browser ran synthetic scan only | Real isolated cleanup after multiple deployments |
| Infrastructure jobs / workers | Shared CRUD/run/logs; OS-correct Go commands, directory prompts and app filters; scoped API and process tests | Browser recheck of updated forms |
| Infrastructure AI operations | Shared cards and scoped recovery; backend refuses stale evidence, healthy apps and database dependency failures; browser displays recovery blocker | Broader unhealthy disposable app scenario |
| Runtimes / tools | Shared inventory, version selection and service operations; tests for custom paths, service reuse and separate pinned runtimes; browser opened version installer | End-to-end isolated installation matrix for all supported tools |
| Agent access / updates | Browser checked version/access/revoke/rename/removal controls. Compatibility tests validate supervised update transport | Rebuild and install the updated agent; recovery check |
| Global accounts / settings | Intentionally Manager-wide; server selection must not change account ownership or expose local resource actions | Browser navigation and role check |

## Evidence boundaries

The browser preview uses synthetic, explicitly isolated fixtures on loopback port 4013. Screenshots
prove layout and interaction, not real remote service execution. API integration tests use an ephemeral,
password-protected PostgreSQL cluster on a random loopback port. Caddy tests use a separate fixture
configuration. No production application has been removed or redeployed for this audit.

Evidence screenshots are stored locally in the ManagerValidation/server-feature-parity-20261109
folder. Production baseline hashes and process observations are recorded separately, without secrets.
The earlier fresh-install work did not prove a real operating-system reboot: the disposable VMs did
not return a post-reboot receipt, and the user has no spare VM. Do not describe it as verified.

A successful build or a shared component does not establish full functional parity. Complete the
remaining rows and rerun affected integration checks before publishing a parity-complete release.
