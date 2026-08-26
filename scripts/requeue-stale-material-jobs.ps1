$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
$baseUrl = if ($env:NEXT_PUBLIC_POCKETBASE_URL) { $env:NEXT_PUBLIC_POCKETBASE_URL.TrimEnd("/") } else { "http://127.0.0.1:8090" }
$token = (Get-Content -LiteralPath (Join-Path $workspace ".analysis-worker-token") -Raw).Trim()
$headers = @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" }
$jobs = (Invoke-RestMethod "$baseUrl/api/collections/material_analysis_jobs/records?perPage=500").items
$now = [DateTimeOffset]::UtcNow
$requeued = 0
foreach ($job in $jobs) {
  $staleRunning = $false
  if ($job.status -eq "running" -and $job.lease_until) {
    $staleRunning = [DateTimeOffset]::Parse([string]$job.lease_until) -le $now
  }
  $recoverableFailure = $job.status -eq "failed" -and [string]$job.error -match "SSL|EOF|timed? out|timeout|write operation|read operation|streaming API returned no complete JSON"
  if (-not $staleRunning -and -not $recoverableFailure) { continue }
  Invoke-RestMethod -Method Post -Headers $headers -Uri "$baseUrl/api/lumina/material-analysis/jobs/$($job.id)/retry" | Out-Null
  $requeued++
}
Write-Output "Requeued $requeued stale material job(s)."
