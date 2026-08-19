$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
$workerScript = Join-Path $PSScriptRoot "start-analysis-worker.ps1"
$baseUrl = if ($env:NEXT_PUBLIC_POCKETBASE_URL) { $env:NEXT_PUBLIC_POCKETBASE_URL.TrimEnd('/') } else { "http://127.0.0.1:8090" }
$healthy = $false
for ($attempt = 0; $attempt -lt 120; $attempt++) {
  try {
    $response = Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 2
    if ($response.code -eq 200) { $healthy = $true; break }
  } catch {}
  Start-Sleep -Milliseconds 500
}
if (-not $healthy) { throw "PocketBase did not become healthy at $baseUrl within 60 seconds." }
$logs = @(
  @{ Queue = "drama"; Output = ".analysis-worker-drama.stdout.log"; Error = ".analysis-worker-drama.stderr.log" },
  @{ Queue = "material"; Output = ".analysis-worker-material.stdout.log"; Error = ".analysis-worker-material.stderr.log" }
)
foreach ($item in $logs) {
  Start-Process -FilePath "powershell.exe" `
    -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $workerScript, "-Queue", $item.Queue `
    -WorkingDirectory $workspace `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $workspace $item.Output) `
    -RedirectStandardError (Join-Path $workspace $item.Error)
}
Write-Output "Started independent drama and material workers."
