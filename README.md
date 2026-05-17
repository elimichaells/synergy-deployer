# Server Manager (PM2 + GitHub)

Centralized server management for multiple projects on a single host. This build targets:

- Single server
- GitHub-based deployments
- PM2 for runtime
- Multi-user roles (admin, operator, viewer)

## Quick Start

### One-command bootstrap (new server)

Prerequisites:
- Node.js + npm
- PM2 (`npm i -g pm2`)
- PostgreSQL running and reachable
- Caddy binary at `C:\web\caddy.exe`

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-manager.ps1 `
  -ManagerDomain deploy.example.com `
  -AdminEmail admin@example.com `
  -AdminPassword 'StrongPassword!123' `
  -DbPassword 'your-postgres-password'
```

This command will:
- write `.env.local`
- apply `db/schema.sql`
- create/update an admin user
- create/update `C:\web\Caddyfile` with the manager domain block
- start `manager` and `caddy` under PM2 and persist with `pm2 save`

### Manual setup

1. Install dependencies

```bash
cd C:\web\manager-v2
npm install
```

2. Configure environment

Create `.env.local`:

```env
JWT_SECRET=change-this-secret
DATABASE_URL=postgres://postgres:password@localhost:5432/server_manager
GITHUB_TOKEN=ghp_xxxxx
PRODUCTION_PATH=C:\\web\\production
```

3. Create database schema

```bash
psql "%DATABASE_URL%" -f db/schema.sql
```

4. Create the first admin user

```sql
insert into users (email, name, password_hash, role)
values ('admin@local', 'Admin', '$2b$12$REPLACE_WITH_BCRYPT', 'admin');
```

Generate a bcrypt hash:

```bash
node -e "console.log(require('bcrypt').hashSync('your-password', 12))"
```

5. Run the app

```bash
npm run dev
```

Open `http://localhost:4000`.

## Project Registration Fields

- `name`: Display name
- `repoUrl`: GitHub HTTPS clone URL (optional)
- `defaultBranch`: Defaults to `main`
- `rootPath`: Local path where repo is cloned
- `installCmd`: e.g. `npm install`
- `buildCmd`: e.g. `npm run build`
- `startCmd`: e.g. `npm start`
- `pm2Name`: Process name in PM2
- `port` + `url`: Optional metadata

If `startCmd` begins with `npm`, deployments will use:

```
pm2 start npm --name "<pm2Name>" -- <startCmd-without-npm>
```

## API Overview

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/:id`
- `PATCH /api/projects/:id`
- `DELETE /api/projects/:id`
- `POST /api/projects/:id/deploy`
- `GET /api/deployments`
- `GET /api/services`
- `GET /api/users` (admin only)
- `POST /api/users` (admin only)

## Notes

- The deployment pipeline runs on the same server as this app.
- For private GitHub repos, set `GITHUB_TOKEN`.
- Roles:
  - `admin`: full access
  - `operator`: create projects + deploy
  - `viewer`: read-only
 - Auto-register looks under `PRODUCTION_PATH` and adds any missing folders as projects.
