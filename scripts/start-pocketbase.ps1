$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
$tokenFile = Join-Path $workspace ".analysis-worker-token"
if (Test-Path -LiteralPath $tokenFile) {
  $env:LUMINA_WORKER_TOKEN = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
}
$pocketBase = Join-Path $workspace "tools\pocketbase\pocketbase.exe"
$dataDir = Join-Path $workspace "pb_data"
$migrationsDir = Join-Path $workspace "pb_migrations"
$hooksDir = Join-Path $workspace "pb_hooks"
& $pocketBase serve `
  --http=127.0.0.1:8090 `
  --dir=$dataDir `
  --migrationsDir=$migrationsDir `
  --hooksDir=$hooksDir `
  --hooksWatch=false
