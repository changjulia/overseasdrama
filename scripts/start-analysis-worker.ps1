$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
$analysisEnvFile = Join-Path $workspace ".env.analysis.local"
if (Test-Path -LiteralPath $analysisEnvFile) {
  foreach ($line in Get-Content -LiteralPath $analysisEnvFile) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#") -or -not $trimmed.Contains("=")) { continue }
    $parts = $trimmed.Split("=", 2)
    $name = $parts[0].Trim()
    $value = $parts[1].Trim().Trim('"').Trim("'")
    if ($name -and -not [Environment]::GetEnvironmentVariable($name, "Process")) {
      Set-Item -Path ("Env:" + $name) -Value $value
    }
  }
}
$tokenFile = Join-Path $workspace ".analysis-worker-token"
if (-not $env:LUMINA_WORKER_TOKEN -and (Test-Path -LiteralPath $tokenFile)) { $env:LUMINA_WORKER_TOKEN = (Get-Content -LiteralPath $tokenFile -Raw).Trim() }
if (-not $env:LUMINA_WORKER_TOKEN) { throw "Set LUMINA_WORKER_TOKEN or create .analysis-worker-token before starting the worker." }
if (-not $env:LUMINA_SEMANTIC_API_KEY -and -not $env:DASHSCOPE_API_KEY -and -not $env:OPENAI_API_KEY) { throw "Set DASHSCOPE_API_KEY (Qwen), LUMINA_SEMANTIC_API_KEY, or OPENAI_API_KEY before starting; queued jobs are preserved until semantic analysis is configured." }
$env:LUMINA_SEMANTIC_PROVIDER = if ($env:LUMINA_SEMANTIC_PROVIDER) { $env:LUMINA_SEMANTIC_PROVIDER } else { "openai-chat-completions" }
$env:LUMINA_SEMANTIC_ENDPOINT = if ($env:LUMINA_SEMANTIC_ENDPOINT) { $env:LUMINA_SEMANTIC_ENDPOINT } else { "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions" }
$env:LUMINA_SEMANTIC_MODEL = if ($env:LUMINA_SEMANTIC_MODEL) { $env:LUMINA_SEMANTIC_MODEL } else { "qwen3-vl-plus" }
$env:LUMINA_WHISPER_MODEL = if ($env:LUMINA_WHISPER_MODEL) { $env:LUMINA_WHISPER_MODEL } else { "small" }
$env:LUMINA_WHISPER_DEVICE = if ($env:LUMINA_WHISPER_DEVICE) { $env:LUMINA_WHISPER_DEVICE } else { "cpu" }
$env:LUMINA_WHISPER_COMPUTE_TYPE = if ($env:LUMINA_WHISPER_COMPUTE_TYPE) { $env:LUMINA_WHISPER_COMPUTE_TYPE } else { "int8" }
$env:LUMINA_OCR_LANGUAGE = if ($env:LUMINA_OCR_LANGUAGE) { $env:LUMINA_OCR_LANGUAGE } else { "en" }
$env:FLAGS_use_mkldnn = "0"
$env:PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK = "True"
$baseUrl = if ($env:NEXT_PUBLIC_POCKETBASE_URL) { $env:NEXT_PUBLIC_POCKETBASE_URL } else { "http://127.0.0.1:8090" }
$bundledPython = "C:\Users\EDY\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
$python = if ($env:LUMINA_PYTHON_EXE) { $env:LUMINA_PYTHON_EXE } elseif (Test-Path -LiteralPath $bundledPython) { $bundledPython } else { "python" }
$ffmpeg = Get-ChildItem -Path (Join-Path $workspace "tools\ffmpeg") -Recurse -Filter "ffmpeg.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($ffmpeg) { $env:PATH = "$($ffmpeg.DirectoryName);$env:PATH" }
Push-Location $workspace
try {
  & $python -m processor.job_worker --base-url $baseUrl
} finally {
  Pop-Location
}
