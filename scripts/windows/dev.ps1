#!/usr/bin/env pwsh
<#
.SYNOPSIS
  One-command local bootstrap for Scriptorium on Windows PowerShell.

.DESCRIPTION
  Verifies Node, enables pnpm via Corepack, installs dependencies, bundles the
  browser client, and starts the server. By default it runs the in-memory store
  (no database needed) — perfect for a first look; data resets on restart.

.PARAMETER Docker
  Ignore everything else and run the full stack (app + Postgres) via
  docker compose up --build.

.PARAMETER Postgres
  Run against a Postgres database. Pass a connection string, e.g.
  "postgres://scriptorium:scriptorium@localhost:5432/scriptorium".
  Applies migrations before starting.

.PARAMETER Test
  Run typecheck + the test suite and exit (no server).

.PARAMETER Port
  Port to listen on (default 3000).

.EXAMPLE
  ./scripts/windows/dev.ps1                 # in-memory, http://localhost:3000
.EXAMPLE
  ./scripts/windows/dev.ps1 -Docker         # full stack via Docker
.EXAMPLE
  ./scripts/windows/dev.ps1 -Postgres "postgres://scriptorium:scriptorium@localhost:5432/scriptorium"
.EXAMPLE
  ./scripts/windows/dev.ps1 -Test           # run checks and exit
#>
[CmdletBinding()]
param(
  [switch]$Docker,
  [string]$Postgres,
  [switch]$Test,
  [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'

# Always operate from the repository root (this script lives in scripts/windows).
$RepoRoot = (Resolve-Path (Join-Path (Join-Path $PSScriptRoot '..') '..')).Path
Set-Location $RepoRoot

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# --- Docker path: hands everything to Compose -------------------------------
if ($Docker) {
  Write-Step 'Starting full stack with Docker Compose (app + Postgres)...'
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker was not found on PATH. Install Docker Desktop, or run without -Docker for in-memory mode.'
  }
  docker compose up --build
  exit $LASTEXITCODE
}

# --- Verify Node ------------------------------------------------------------
Write-Step 'Checking Node.js...'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js was not found. Install Node 20+ from https://nodejs.org and re-run.'
}
$nodeVersion = (node -v).TrimStart('v')
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 20) {
  throw "Node 20+ is required (found $nodeVersion). Please upgrade."
}
Write-Host "Node $nodeVersion OK"

# --- Enable pnpm via Corepack ----------------------------------------------
Write-Step 'Enabling pnpm (Corepack)...'
try {
  corepack enable | Out-Null
  corepack prepare pnpm@10.33.0 --activate | Out-Null
}
catch {
  Write-Warning 'corepack failed (often a permissions issue).'
  Write-Warning 'Run "corepack enable" once in an Administrator PowerShell, then re-run this script.'
  throw
}
$pnpmVersion = (pnpm -v)
Write-Host "pnpm $pnpmVersion OK"

# --- Install + build client -------------------------------------------------
Write-Step 'Installing dependencies (pnpm install)...'
pnpm install

Write-Step 'Bundling the browser client...'
pnpm build:client

# --- Test-and-exit path -----------------------------------------------------
if ($Test) {
  Write-Step 'Typechecking...'
  pnpm typecheck
  Write-Step 'Running tests...'
  pnpm test
  Write-Host "`nChecks complete." -ForegroundColor Green
  exit $LASTEXITCODE
}

# --- Configure store + run --------------------------------------------------
$env:PORT = "$Port"

if ($Postgres) {
  Write-Step 'Configuring Postgres store...'
  $env:DATABASE_URL = $Postgres
  Write-Host "DATABASE_URL set for this session."
  Write-Step 'Applying migrations...'
  pnpm migrate
}
else {
  # Make sure a stray DATABASE_URL from this shell doesn't force Postgres.
  Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
  Write-Host "`nUsing the in-memory store (no database). Data resets on restart." -ForegroundColor Yellow
  Write-Host "Pass -Postgres '<connection string>' or -Docker to persist." -ForegroundColor Yellow
}

Write-Step "Starting Scriptorium on http://localhost:$Port ..."
Write-Host "  Instructor sign-in: http://localhost:$Port/login.html"
Write-Host "  (demo login: instructor@example.com / demo-password-123)"
Write-Host "  The demo student link is printed below once the server starts."
Write-Host "  Press Ctrl+C to stop.`n"

pnpm start
