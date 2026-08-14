$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
$workerScript = Join-Path $PSScriptRoot "start-analysis-worker.ps1"
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
