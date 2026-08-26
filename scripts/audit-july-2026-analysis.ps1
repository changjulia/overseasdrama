param([string]$BaseUrl = "http://127.0.0.1:8090")
$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
$materialManifest = Get-Content (Join-Path $workspace "analysis_artifacts/july-2026-top15x10-import.json") -Raw | ConvertFrom-Json
$dramaManifest = Get-Content (Join-Path $workspace "analysis_artifacts/july-2026-top15-drama-import.json") -Raw | ConvertFrom-Json

function Get-AllRecords([string]$Collection) {
  $records = @(); $page = 1
  do {
    $response = Invoke-RestMethod "$BaseUrl/api/collections/$Collection/records?page=$page&perPage=200"
    $records += @($response.items); $page++
  } while ($page -le $response.totalPages)
  return $records
}

$materialIds = @{}; $materialManifest.targets | ForEach-Object { $materialIds[[string]$_.recordId] = $_ }
$dramaIds = @{}; $dramaManifest.dramas | ForEach-Object { $dramaIds[[string]$_.recordId] = $_ }
$materialJobs = @(Get-AllRecords "material_analysis_jobs" | Where-Object { $materialIds.ContainsKey([string]$_.material) })
$dramaJobs = @(Get-AllRecords "analysis_jobs" | Where-Object { $dramaIds.ContainsKey([string]$_.drama) })

$materialBad = @($materialJobs | Where-Object {
  if ($_.status -ne "succeeded") { return $false }
  $root = $_.result.result
  $gateMissing = $null -eq $root.qualityGate
  $gateNoncompliant = -not $gateMissing -and $root.qualityGate.passed -ne $true -and $root.review.status -ne "needs_review"
  -not [string]$root.content.summary.value -or @($root.content.summary.evidence).Count -eq 0 -or $null -eq $root.review -or $gateMissing -or $gateNoncompliant
} | ForEach-Object { [pscustomobject]@{ id=$_.id; material=$_.material; reason="missing summary/evidence/review, stored qualityGate, or needs_review downgrade" } })
$materialSucceeded = @($materialJobs | Where-Object { $_.status -eq "succeeded" })
$materialGatePassed = @($materialSucceeded | Where-Object { $_.result.result.qualityGate.passed -eq $true }).Count
$materialNeedsReview = @($materialSucceeded | Where-Object { $_.result.result.qualityGate.passed -eq $false -and $_.result.result.review.status -eq "needs_review" }).Count
$materialGateMissing = $materialSucceeded.Count - $materialGatePassed - $materialNeedsReview
$coarseBad = @($dramaJobs | Where-Object {
  if ($_.stage -ne "coarse" -or $_.status -ne "succeeded") { return $false }
  $summary = $_.result.result.episodeSummary
  -not [string]$summary.value -or $summary.verification -ne "verified" -or @($summary.evidence).Count -eq 0
} | ForEach-Object { [pscustomobject]@{ id=$_.id; episode=$_.episode; reason="missing verified episode summary evidence" } })

$report = [ordered]@{
  generatedAt = (Get-Date).ToString("o")
  materials = [ordered]@{
    expected = $materialManifest.targets.Count
    jobs = $materialJobs.Count
    statuses = @($materialJobs | Group-Object status | ForEach-Object { [pscustomobject]@{status=$_.Name;count=$_.Count} })
    evidenceGate = [ordered]@{ passed=$materialGatePassed; needsReview=$materialNeedsReview; missing=$materialGateMissing }
    succeededQualityFailures = $materialBad
  }
  dramas = [ordered]@{
    expected = $dramaManifest.dramas.Count
    expectedEpisodes = [int](($dramaManifest.dramas | Measure-Object totalEpisodes -Sum).Sum)
    statuses = @($dramaJobs | Group-Object stage,status | ForEach-Object { [pscustomobject]@{stage=$_.Group[0].stage;status=$_.Group[0].status;count=$_.Count} })
    succeededCoarseQualityFailures = $coarseBad
  }
}
$report | ConvertTo-Json -Depth 8
if ($materialBad.Count -or $coarseBad.Count) { exit 2 }
