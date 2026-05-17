# Quick Start

## One-command bootstrap (new server)

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-manager.ps1 `
  -ManagerDomain deploy.example.com `
  -AdminEmail admin@example.com `
  -AdminPassword 'StrongPassword!123' `
  -DbPassword 'your-postgres-password'
```

Prerequisites:
- Node.js + npm
- PM2 installed globally (`npm i -g pm2`)
- PostgreSQL running
- `C:\web\caddy.exe` exists

## Manual setup

1. Install dependencies

```powershell
cd C:\web\manager-v2
npm install
```

2. Configure `.env.local`

```env
JWT_SECRET=change-this-secret
DATABASE_URL=postgres://postgres:password@localhost:5432/server_manager
GITHUB_TOKEN=ghp_xxxxx
PRODUCTION_PATH=C:\\web\\production
```

3. Create schema

```powershell
psql "%DATABASE_URL%" -f db/schema.sql
```

4. Create the first admin user

```sql
insert into users (email, name, password_hash, role)
values ('admin@local', 'Admin', '$2b$12$REPLACE_WITH_BCRYPT', 'admin');
```

5. Run the app

```powershell
npm run dev
```

Open `http://localhost:4000`.
