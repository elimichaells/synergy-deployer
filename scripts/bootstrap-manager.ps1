param(
    [Parameter(Mandatory = $true)]
    [string]$ManagerDomain,

    [Parameter(Mandatory = $true)]
    [string]$AdminEmail,

    [Parameter(Mandatory = $true)]
    [string]$AdminPassword,

    [Parameter(Mandatory = $true)]
    [string]$DbPassword,

    [string]$AdminName = 'Admin',
    [string]$ManagerRoot = 'C:\web\manager',
    [string]$WebRoot = 'C:\web',
    [string]$DbHost = 'localhost',
    [int]$DbPort = 5432,
    [string]$DbName = 'server_manager',
    [string]$DbUser = 'postgres',
    [switch]$SkipNpmInstall,
    [switch]$SkipBuild,
    [switch]$ForceRewriteCaddyfile
)

$ErrorActionPreference = 'Stop'

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function New-RandomSecret {
    param([int]$Length = 64)
    $chars = @()
    $chars += [char[]]'abcdefghijklmnopqrstuvwxyz'
    $chars += [char[]]'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    $chars += [char[]]'0123456789'
    return -join (1..$Length | ForEach-Object { $chars | Get-Random })
}

$productionPath = Join-Path $WebRoot 'production'
$stagingPath = Join-Path $WebRoot 'staging'
$logsPath = Join-Path $WebRoot 'logs'
$caddyPath = $WebRoot
$caddyExe = Join-Path $WebRoot 'caddy.exe'
$caddyfilePath = Join-Path $WebRoot 'Caddyfile'
$jwtSecret = New-RandomSecret

if (-not (Test-Path $ManagerRoot)) {
    throw "Manager root not found: $ManagerRoot"
}
if (-not (Test-Path $caddyExe)) {
    throw "Caddy binary not found: $caddyExe"
}

Write-Step 'Creating base directories'
New-Item -ItemType Directory -Force -Path $WebRoot | Out-Null
New-Item -ItemType Directory -Force -Path $productionPath | Out-Null
New-Item -ItemType Directory -Force -Path $stagingPath | Out-Null
New-Item -ItemType Directory -Force -Path $logsPath | Out-Null
New-Item -ItemType Directory -Force -Path 'C:\Caddy\logs' | Out-Null

Push-Location $ManagerRoot
try {
    $env:DB_HOST = $DbHost
    $env:DB_PORT = "$DbPort"
    $env:DB_NAME = $DbName
    $env:DB_USER = $DbUser
    $env:DB_PASSWORD = $DbPassword
    $env:ADMIN_EMAIL = $AdminEmail
    $env:ADMIN_NAME = $AdminName
    $env:ADMIN_PASSWORD = $AdminPassword

    $envPath = Join-Path $ManagerRoot '.env.local'

    Write-Step 'Writing manager .env.local'
    @"
DATABASE_HOST=$DbHost
DATABASE_PORT=$DbPort
DATABASE_NAME=$DbName
DATABASE_USER=$DbUser
DATABASE_PASSWORD=$DbPassword
JWT_SECRET=$jwtSecret
PRODUCTION_PATH=$($productionPath -replace '\\', '\\')
STAGING_PATH=$($stagingPath -replace '\\', '\\')
LOGS_PATH=$($logsPath -replace '\\', '\\')
CADDY_PATH=$($caddyPath -replace '\\', '\\')
"@ | Set-Content -Path $envPath -Encoding UTF8

    if (-not $SkipNpmInstall) {
        Write-Step 'Installing npm dependencies'
        npm install
    }

    if (-not $SkipBuild) {
        Write-Step 'Building manager app'
        npm run build
    }

    Write-Step 'Applying manager database schema'
    @'
const fs = require('fs')
const path = require('path')
const { Client } = require('pg')

async function main() {
  const schemaPath = path.join(process.cwd(), 'db', 'schema.sql')
  const sql = fs.readFileSync(schemaPath, 'utf8')
  const client = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  })
  await client.connect()
  await client.query(sql)
  await client.end()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
'@ | node -

    Write-Step 'Creating or updating initial admin user'
    @'
const { Client } = require('pg')
const bcrypt = require('bcrypt')

async function main() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  })
  await client.connect()

  const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12)
  await client.query(
    `insert into users (email, name, password_hash, role, status)
     values ($1, $2, $3, 'admin', 'active')
     on conflict (email) do update
       set name = excluded.name,
           password_hash = excluded.password_hash,
           role = 'admin',
           status = 'active'`,
    [process.env.ADMIN_EMAIL, process.env.ADMIN_NAME, passwordHash]
  )

  await client.end()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
'@ | node -

    Write-Step 'Preparing Caddyfile'
    $managerBlock = @"
# $ManagerDomain
$ManagerDomain {
	reverse_proxy 127.0.0.1:4000 {
		header_up Host {host}
		header_up X-Real-IP {remote}
	}

	log {
		output file C:\Caddy\logs\manager-$($ManagerDomain -replace '\.', '-')-error.log {
			roll_size 10MB
			roll_keep 5
		}
		format console
		level ERROR
	}
}
"@

    if (-not (Test-Path $caddyfilePath) -or $ForceRewriteCaddyfile) {
        Set-Content -Path $caddyfilePath -Value $managerBlock -Encoding UTF8
    }
    else {
        $existingCaddy = Get-Content -Path $caddyfilePath -Raw
        if ($existingCaddy -notmatch [regex]::Escape("$ManagerDomain {")) {
            Add-Content -Path $caddyfilePath -Value "`r`n$managerBlock"
        }
    }

    Write-Step 'Validating Caddy config'
    & $caddyExe validate --config $caddyfilePath --adapter caddyfile

    Write-Step 'Starting manager with PM2'
    pm2 delete manager | Out-Null
    $managerNextBin = Join-Path $ManagerRoot 'node_modules\next\dist\bin\next'
    pm2 start $managerNextBin --interpreter node --name manager -- start -p 4000

    Write-Step 'Starting Caddy with PM2'
    pm2 delete caddy | Out-Null
    pm2 start $caddyExe --name caddy --interpreter none -- start --config $caddyfilePath --adapter caddyfile
    pm2 save

    Write-Host ''
    Write-Host 'Bootstrap complete.' -ForegroundColor Green
    Write-Host "Manager URL: https://$ManagerDomain" -ForegroundColor Green
    Write-Host "Admin email: $AdminEmail" -ForegroundColor Green
    Write-Host 'Admin password: (as provided in command)' -ForegroundColor Green
}
finally {
    Pop-Location
}
