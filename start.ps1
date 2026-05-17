# TrueID Manager v2.0 Startup Script

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "     TrueID Manager v2.0 - Professional UI     " -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

# Check if node_modules exists
if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Yellow
    npm install
    Write-Host ""
}

# Check if shadcn is initialized
if (-not (Test-Path "components/ui")) {
    Write-Host "shadcn/ui not initialized!" -ForegroundColor Red
    Write-Host "Please run: npx shadcn-ui@latest init" -ForegroundColor Yellow
    Write-Host "Then install components as described in QUICK-START.md" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

# Check for .env.local
if (-not (Test-Path ".env.local")) {
    Write-Host "Creating .env.local template..." -ForegroundColor Yellow
    @"
JWT_SECRET=change-this-to-a-random-secret-key
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=\$2b\$10\$yourhashhere

PRODUCTION_PATH=C:\\web\\production
LOGS_PATH=C:\\web\\logs
CADDY_PATH=C:\\web

DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=trueid
DATABASE_USER=postgres
DATABASE_PASSWORD=trueidpgsl2026
"@ | Out-File -FilePath ".env.local" -Encoding UTF8

    Write-Host ""
    Write-Host "Created .env.local - Please edit it with your settings!" -ForegroundColor Yellow
    Write-Host "Generate password hash with: node -e ""console.log(require('bcrypt').hashSync('password', 10))""" -ForegroundColor Cyan
    Write-Host ""
    notepad .env.local
    exit 0
}

# Start the server
Write-Host "Starting TrueID Manager v2.0..." -ForegroundColor Green
Write-Host ""
Write-Host "Dashboard will open at: http://localhost:4000" -ForegroundColor Cyan
Write-Host ""
Write-Host "Features:" -ForegroundColor White
Write-Host "  - Modern UI with shadcn/ui components" -ForegroundColor Gray
Write-Host "  - Real-time service monitoring" -ForegroundColor Gray
Write-Host "  - Live log streaming" -ForegroundColor Gray
Write-Host "  - File browser & editor" -ForegroundColor Gray
Write-Host "  - Database query browser" -ForegroundColor Gray
Write-Host "  - System metrics dashboard" -ForegroundColor Gray
Write-Host ""
Write-Host "Press Ctrl+C to stop" -ForegroundColor Yellow
Write-Host ""

Start-Sleep -Seconds 2
Start-Process "http://localhost:4000"
npm run dev
