param(
  [ValidateRange(1, 65535)]
  [int]$Port = 8090
)

$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
# Custom UI routes are only exposed to the localhost Vite gateway. Hosted or
# shared deployments must not enable this process-level trust boundary.
$env:LUMINA_UI_MODE = "local-loopback"
# PocketBase's JS request host can be normalized to the upstream proxy host on
# Windows. Keep explicit browser origins as a reliable local-dev fallback.
if (-not $env:LUMINA_UI_ORIGINS) {
  $env:LUMINA_UI_ORIGINS = @(
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    "http://localhost:5173",
    "http://127.0.0.1:5173"
  ) -join ","
}
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
$migrationsDir = Join-Path $workspace "pb_migrations"
$hooksDir = Join-Path $workspace "pb_hooks"
$renderDir = Join-Path $workspace "public\renders"
$env:LUMINA_FACTORY_RENDER_DIR = [System.IO.Path]::GetFullPath($renderDir)
Write-Host "PocketBase persistent data: $dataDir"
Write-Host "PocketBase hooks: $hooksDir"
Write-Host "Factory render artifacts: $env:LUMINA_FACTORY_RENDER_DIR"
if ($env:LUMINA_AUTO_START_WORKERS -ne "0") {
  $workerSupervisor = Join-Path $PSScriptRoot "start-analysis-workers.ps1"
  $workerSupervisorOut = Join-Path $workspace ".analysis-workers-supervisor.stdout.log"
  $workerSupervisorError = Join-Path $workspace ".analysis-workers-supervisor.stderr.log"
  Start-Process -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $workerSupervisor) `
    -WorkingDirectory $workspace `
    -WindowStyle Hidden `
    -RedirectStandardOutput $workerSupervisorOut `
    -RedirectStandardError $workerSupervisorError | Out-Null
  Write-Host "Analysis worker supervisor: enabled (set LUMINA_AUTO_START_WORKERS=0 to disable)"
}
& $pocketBase serve `
  --http="127.0.0.1:$Port" `
  --dir=$dataDir `
  --migrationsDir=$migrationsDir `
  --hooksDir=$hooksDir `
  --hooksWatch=false `
  --automigrate=false
