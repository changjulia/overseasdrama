$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
$workerScript = Join-Path $PSScriptRoot "start-analysis-worker.ps1"
$supervisorPidFile = Join-Path $workspace ".analysis-workers-supervisor.pid"
if (Test-Path -LiteralPath $supervisorPidFile) {
  $existingSupervisorPid = 0
  if ([int]::TryParse((Get-Content -LiteralPath $supervisorPidFile -Raw).Trim(), [ref]$existingSupervisorPid)) {
    $existingSupervisor = Get-CimInstance Win32_Process -Filter "ProcessId = $existingSupervisorPid" -ErrorAction SilentlyContinue
    $expectedSupervisorScript = [System.IO.Path]::GetFileName($PSCommandPath)
    if ($existingSupervisor -and $existingSupervisor.CommandLine -like "*$expectedSupervisorScript*") {
      Write-Output "Analysis worker supervisor is already running (PID $existingSupervisorPid)."
      exit 0
    }
  }
  Remove-Item -LiteralPath $supervisorPidFile -Force -ErrorAction SilentlyContinue
}
[System.IO.File]::WriteAllText($supervisorPidFile, [string]$PID)
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
  @{ Queue = "drama"; Instance = ""; Output = ".analysis-worker-drama.stdout.log"; Error = ".analysis-worker-drama.stderr.log" },
  @{ Queue = "material"; Instance = ""; Output = ".analysis-worker-material.stdout.log"; Error = ".analysis-worker-material.stderr.log" },
  @{ Queue = "material"; Instance = "interactive"; Output = ".analysis-worker-material-interactive.stdout.log"; Error = ".analysis-worker-material-interactive.stderr.log" }
)
try {
  while ($true) {
    foreach ($item in $logs) {
      $instanceSuffix = if ($item.Instance) { "-" + $item.Instance } else { "" }
      $workerPidFile = Join-Path $workspace (".analysis-worker-" + $item.Queue + $instanceSuffix + ".pid")
      $workerAlive = $false
      if (Test-Path -LiteralPath $workerPidFile) {
        $workerPid = 0
        if ([int]::TryParse((Get-Content -LiteralPath $workerPidFile -Raw).Trim(), [ref]$workerPid)) {
          $workerProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $workerPid" -ErrorAction SilentlyContinue
          $expectedWorkerScript = [System.IO.Path]::GetFileName($workerScript)
          $workerAlive = $workerProcess -and $workerProcess.CommandLine -like "*$expectedWorkerScript*" -and $workerProcess.CommandLine -like "*-Queue*$($item.Queue)*"
          if ($workerAlive -and $item.Instance) { $workerAlive = $workerProcess.CommandLine -like "*-Instance*$($item.Instance)*" }
        }
        if (-not $workerAlive) { Remove-Item -LiteralPath $workerPidFile -Force -ErrorAction SilentlyContinue }
      }
      if (-not $workerAlive) {
        $workerArguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $workerScript, "-Queue", $item.Queue)
        if ($item.Instance) { $workerArguments += @("-Instance", $item.Instance) }
        Start-Process -FilePath "powershell.exe" `
          -ArgumentList $workerArguments `
          -WorkingDirectory $workspace `
          -WindowStyle Hidden `
          -RedirectStandardOutput (Join-Path $workspace $item.Output) `
          -RedirectStandardError (Join-Path $workspace $item.Error)
      }
    }
    Start-Sleep -Seconds 5
  }
} finally {
  if ((Test-Path -LiteralPath $supervisorPidFile) -and ((Get-Content -LiteralPath $supervisorPidFile -Raw).Trim() -eq [string]$PID)) {
    Remove-Item -LiteralPath $supervisorPidFile -Force -ErrorAction SilentlyContinue
  }
}
