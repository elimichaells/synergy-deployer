# GitLab, Gitea and GitHub repositories

Synergy Deployer 2.18.0 supports GitHub.com and self-hosted GitLab and Gitea over **HTTPS with access tokens**. SSH keys, plain HTTP and filesystem repository URLs are not supported by this connection workflow. Existing GitHub connections and application assignments remain valid.

## Connect an institution's Git server

1. Install Synergy Deployer on Windows Server 2019 using the current installer. Confirm that the deployer server can resolve and reach the Git server's HTTPS address. A LAN Git server does not need to be exposed to the public internet.
2. Sign in as a deployer administrator. Open **Settings > Connections > Self-hosted Git > Add connection**.
3. Select **GitLab** or **Gitea**, enter a recognizable connection name and the server's external HTTPS base address. Custom ports and installation subpaths are supported, for example `https://git.institution.edu:8443/code`. Use the address before `/api/...` or the repository path.
4. Enter an access token for an account that can read the intended repositories. GitLab supports nested groups. Gitea repositories use `owner/repository` paths.
5. If the Git server uses an institutional certificate authority, paste its public root/intermediate CA certificates in the optional PEM field. Do not paste a private key. TLS verification remains enabled for both API requests and Git operations.
6. Select **Verify and save**. Verification checks the account API. The first repository preparation checks access to that specific repository and branch.

Token permissions depend on the features used:

| Provider | Browse and deploy | Configure push webhooks | Promote by pushing a branch |
| --- | --- | --- | --- |
| GitLab | Personal access token with `read_api` and `read_repository`; repository read access | `api` scope and a role permitted to manage project webhooks (normally Maintainer) | `write_repository` or `api`, plus permission to push the target branch |
| Gitea | Access token with `read:user` and `read:repository`; repository read access | `write:repository` and repository administration permission | `write:repository`, plus permission to push the target branch |
| GitHub | Existing GitHub account connection with access to the repository | Repository Webhooks read/write | Repository Contents write and permission to push the target branch |

Protected branches and institution policies still apply. A token's scopes alone do not grant access to repositories or protected branches. Account tokens are required for browsing and verification; GitLab deploy tokens that cannot call the account API are not supported here.

## Import and deploy

Open **Add application / Import from Git**, select the saved connection, and choose a repository or paste its HTTPS clone URL. The repository must belong to the selected server, including its configured port and base path. Public GitHub repositories can also be imported without a connection.

Complete repository preparation, framework, database, environment and domain setup, then deploy manually. Confirm that the application responds at its configured address. Existing applications can select a connection under their repository settings. Use **Edit** beside a self-hosted connection to rotate its token or update its CA certificates; blank replacement tokens retain the current token. To change provider or server address, create a new connection and reassign applications.

## Deploy on push

After a successful manual deployment, enable **Deploy on every push** in the application's settings. The deployer configures the appropriate GitLab or Gitea push webhook. Production and staging applications using the same repository share its secret, and only applications configured for the pushed branch and enabled for automatic deployment are selected. Each application must have completed setup.

The callback is derived from the installer's saved `MANAGER_URL`:

- GitHub: `/api/webhooks/github`
- GitLab: `/api/webhooks/gitlab`
- Gitea: `/api/webhooks/gitea`

The Git server must be able to reach this URL and trust the deployer's HTTPS certificate. For a local Caddy CA, institution IT must trust the deployer's public root certificate on the GitLab/Gitea host as well as on client computers. Adding the **Git server's** CA to a deployer connection only establishes trust in the other direction.

GitLab and Gitea can restrict webhook access to private network addresses. Permit the specific deployer destination in the Git server's webhook network policy when necessary. Keep certificate verification enabled. The Git server's webhook delivery history shows failed requests; a successful API registration alone does not prove callback delivery. GitHub.com cannot deliver directly to an isolated LAN address.

## Check recovery after a reboot

Before rebooting, complete one manual deployment and, if used, one push-triggered deployment. Record the application URL and deployed commit.

1. Reboot the new Server 2019 machine during the installation test window.
2. From another client, open the deployer and the deployed application **before anyone logs into Windows**. Verify HTTPS sign-in and the application response.
3. Check `Manager PM2 Startup` in Task Scheduler: its last run should be after the boot time and its result should be `0`. Verify the required PostgreSQL services are running. Do not run `pm2 resurrect` manually before this check, because that would hide a startup failure.
4. In **Settings > Connections**, test the saved Git connection. It should succeed without entering the token again.
5. Commit a harmless change to a test branch. Deploy it manually and verify the new commit and application behavior. If automatic deployment is enabled, push another change and confirm a successful webhook delivery and deployment on the correct environment.
6. If your workflow promotes staging by pushing production, test promotion on a disposable application with the same branch policies. Confirm that the remote branch changes only after the candidate is healthy.

Saved tokens are AES-GCM encrypted in the control database using the installation's persistent encryption key (`GITHUB_CONNECTIONS_ENCRYPTION_KEY`, or `JWT_SECRET` when no override is set). Back up the database and `.env.local` together; changing or losing this key makes existing tokens unreadable. The historical key and database column names are retained for upgrade compatibility across all three providers.

Git receives repository-scoped credentials only for network commands, not in command-line URLs or application build environments. User credential helpers, user Git configuration, interactive login and SSH agents are not required. Institutional Git CA bundles are reconstructed from saved connection data in `C:\ProgramData\Manager\git-ca`. Git's checkout ownership trust and promotion author identity are supplied per invocation. The installer's SYSTEM startup task restores the saved runtime PATH and starts the deployer from its installed directory.

## Validation included in this release

Automated tests use real HTTPS Git transport and a private repository fixture to clone, fetch and push for both providers in separate Node processes with empty Windows user profiles. They verify persisted token decryption, custom CA trust, clean remote URLs, credential host/path isolation, signature rejection and branch selection. Existing deployment activation/rollback and PM2 boot configuration tests also run.

The HTTP API fixtures follow GitLab/Gitea contracts; they do not replace testing against the institution's actual server version, account permissions and firewall. A physical Server 2019 reboot must still be verified using the steps above. An in-flight build interrupted by a reboot is handled by existing deployment recovery; these changes do not resume an interrupted build halfway through.

Provider references: [GitLab token scopes](https://docs.gitlab.com/user/profile/personal_access_tokens/), [GitLab project webhooks](https://docs.gitlab.com/api/project_webhooks/), [Gitea API authentication](https://docs.gitea.com/development/api-usage/), and [Gitea webhook signatures](https://docs.gitea.com/usage/repository/webhooks/).
