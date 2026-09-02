param(
  [ValidateSet("audit", "enqueue")]
  [string]$Mode = "audit",
  [string]$BaseUrl = "http://127.0.0.1:8090",
  [int]$ThrottleLimit = 8,
  [string]$ReportPath = "analysis_artifacts/ad-materials-full-audit.json"
)
$ErrorActionPreference = "Stop"

function Get-AllRecords([string]$Collection, [string]$Fields) {
  $items = @()
  $page = 1
  do {
    $response = Invoke-RestMethod "$BaseUrl/api/collections/$Collection/records?page=$page&perPage=200&fields=$Fields"
    $items += @($response.items)
    $page += 1
  } while ($page -le $response.totalPages)
  return $items
}

if ($Mode -eq "enqueue") {
  $materials = Get-AllRecords "ad_materials" "id,analysis_status,video,source_url"
  $targets = @($materials | Where-Object { $_.analysis_status -ne "succeeded" -and ($_.video -or $_.source_url) })
  $results = $targets | ForEach-Object -Parallel {
    $uri = "$using:BaseUrl/api/lumina/material-analysis/materials/$($_.id)/retry"
    try {
      $response = Invoke-RestMethod -Method Post -Uri $uri -Headers @{ "X-Lumina-Ui" = "local" } -ContentType "application/json" -Body "{}"
      [pscustomobject]@{ material = $_.id; queued = $true; job = $response.id; status = $response.status; error = "" }
    } catch {
      [pscustomobject]@{ material = $_.id; queued = $false; job = ""; status = "failed"; error = $_.Exception.Message }
    }
  } -ThrottleLimit $ThrottleLimit
  $queueReport = [ordered]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    targetCount = $targets.Count
    queued = @($results | Where-Object queued).Count
    failed = @($results | Where-Object { -not $_.queued }).Count
    failures = @($results | Where-Object { -not $_.queued })
  }
  $queuePath = [System.IO.Path]::ChangeExtension($ReportPath, ".enqueue.json")
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $queuePath) | Out-Null
  $queueReport | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $queuePath -Encoding utf8
  $queueReport | ConvertTo-Json -Depth 8
}

$materials = Get-AllRecords "ad_materials" "id,title,video,source_url,analysis_status,analysis_schema_version,analysis_stage,analysis_error,review_status,ontology_tags,hook_count"
$jobs = Get-AllRecords "material_analysis_jobs" "id,material,status,attempt,max_attempts,error,error_kind,current_stage,progress"
$hooks = Get-AllRecords "hook_assets" "id,material,source_class,boundary_status,review_status,themes,content_tags,relationships,ontology_tags,narrative_promise,evidence,analysis_version"
$external = @($hooks | Where-Object source_class -eq "external_material")
$report = [ordered]@{
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  materials = $materials.Count
  materialStatus = [ordered]@{}
  jobs = $jobs.Count
  jobStatus = [ordered]@{}
  analyzed = @($materials | Where-Object { $_.analysis_status -eq "succeeded" -and $_.analysis_schema_version -eq "material-v2" }).Count
  tagged = @($materials | Where-Object { $_.analysis_status -eq "succeeded" -and @($_.ontology_tags).Count -gt 0 }).Count
  externalHooks = $external.Count
  externalHookMaterials = @($external | Select-Object -ExpandProperty material -Unique).Count
  selectableExternalHooks = @($external | Where-Object { $_.boundary_status -ne "rejected" -and $_.review_status -ne "rejected" -and (@($_.ontology_tags).Count -gt 0 -or @($_.themes).Count -gt 0 -or @($_.content_tags).Count -gt 0) }).Count
  failedMaterials = @($materials | Where-Object analysis_status -eq "failed" | Select-Object id,title,analysis_error)
  failedJobs = @($jobs | Where-Object status -eq "failed" | Select-Object id,material,attempt,max_attempts,error_kind,error)
}
foreach ($group in ($materials | Group-Object analysis_status)) { $report.materialStatus[$group.Name] = $group.Count }
foreach ($group in ($jobs | Group-Object status)) { $report.jobStatus[$group.Name] = $group.Count }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ReportPath) | Out-Null
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding utf8
$report | ConvertTo-Json -Depth 8
