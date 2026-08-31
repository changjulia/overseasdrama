$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
# Custom UI routes are only exposed to the localhost Vite gateway. Hosted or
# shared deployments must not enable this process-level trust boundary.
$env:LUMINA_UI_MODE = "local-loopback"
$tokenFile = Join-Path $workspace ".analysis-worker-token"
if (Test-Path -LiteralPath $tokenFile) {
  $env:LUMINA_WORKER_TOKEN = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
}
$pocketBase = Join-Path $workspace "tools\pocketbase\pocketbase.exe"
$externalDataDir = "D:\LuminaData\external-hook-runtime\pb_data"
$dataDir = if ($env:LUMINA_PB_DATA_DIR) {
  $env:LUMINA_PB_DATA_DIR
} elseif (Test-Path -LiteralPath $externalDataDir) {
  $externalDataDir
} else {
  Join-Path $workspace "pb_data"
}
$dataDir = [System.IO.Path]::GetFullPath($dataDir)
$externalRuntimeRoot = "C:\Users\EDY\Documents\ChatGPT\overseasdrama-external-hook"
$useExternalRuntime =
  $dataDir -eq [System.IO.Path]::GetFullPath($externalDataDir) -and
  (Test-Path -LiteralPath $externalRuntimeRoot)
$migrationsDir = if ($useExternalRuntime) {
  Join-Path $externalRuntimeRoot "pb_migrations"
} else {
  Join-Path $workspace "pb_migrations"
}
$hooksDir = if ($useExternalRuntime) {
  Join-Path $externalRuntimeRoot "pb_hooks"
} else {
  Join-Path $workspace "pb_hooks"
}
Write-Host "PocketBase persistent data: $dataDir"
& $pocketBase serve `
  --http=127.0.0.1:8090 `
  --dir=$dataDir `
  --migrationsDir=$migrationsDir `
  --hooksDir=$hooksDir `
  --hooksWatch=false `
  --automigrate=false
