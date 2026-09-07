$ErrorActionPreference = 'Stop'
$apifyToken = (Get-Clipboard -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($apifyToken)) { throw 'Clipboard is empty.' }
$headers = @{ Authorization = "Bearer $apifyToken"; 'Content-Type' = 'application/json' }
$urls = @(
    'https://www.tiktok.com/@no_longer_afraid/video/6978938440524123397'
    'https://www.tiktok.com/@samuel_thebest2.0/video/7575224648305085713'
    'https://www.tiktok.com/@nbcsandiego/video/7493235915805052191'
    'https://www.tiktok.com/@tvportalsertaopb/video/7512185677308628229'
)
$input = @{
    postURLs = $urls
    resultsPerPage = 4
    shouldDownloadVideos = $true
    shouldDownloadCovers = $false
    shouldDownloadAvatars = $false
    shouldDownloadMusicCovers = $false
    commentsPerPost = 0
    downloadSubtitlesOptions = 'NEVER_DOWNLOAD_SUBTITLES'
} | ConvertTo-Json -Depth 5
$run = Invoke-RestMethod -Method Post -Uri 'https://api.apify.com/v2/acts/GdWCkxBtKWOsKjdch/runs?waitForFinish=150' -Headers $headers -Body $input -TimeoutSec 180
[pscustomobject]@{status=$run.data.status;runId=$run.data.id;datasetId=$run.data.defaultDatasetId;message=$run.data.statusMessage} | ConvertTo-Json -Compress
