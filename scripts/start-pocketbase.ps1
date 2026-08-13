$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
$executable = if ($env:POCKETBASE_EXE) { $env:POCKETBASE_EXE } else { "C:\Users\EDY\Documents\Codex\2026-08-04\ni-k\work\pocketbase\pocketbase.exe" }
if (-not (Test-Path -LiteralPath $executable)) {
  throw "PocketBase executable not found. Set POCKETBASE_EXE to pocketbase.exe."
}
$tokenFile = Join-Path $workspace ".analysis-worker-token"
if (-not $env:LUMINA_WORKER_TOKEN -and (Test-Path -LiteralPath $tokenFile)) { $env:LUMINA_WORKER_TOKEN = (Get-Content -LiteralPath $tokenFile -Raw).Trim() }
if (-not $env:LUMINA_WORKER_TOKEN) { throw "Set LUMINA_WORKER_TOKEN or create .analysis-worker-token before starting PocketBase." }
$dataDir = Join-Path $workspace "pb_data"
$migrationsDir = Join-Path $workspace "pb_migrations"
$hooksDir = Join-Path $workspace "pb_hooks"
$pocketBaseArgs = @(
  "serve",
  "--http=127.0.0.1:8090",
  "--dir=$dataDir",
  "--migrationsDir=$migrationsDir",
  "--hooksDir=$hooksDir"
)
& $executable @pocketBaseArgs
