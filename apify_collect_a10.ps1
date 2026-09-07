$ErrorActionPreference = 'Stop'

$apifyToken = (Get-Clipboard -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($apifyToken)) {
    throw 'Clipboard is empty.'
}

$headers = @{
    Authorization = "Bearer $apifyToken"
    'Content-Type' = 'application/json'
}

$inputObject = @{
    searchQueries = @(
        'mother protects child danger'
        'woman stands up bully'
        'woman catches cheating reaction'
        'woman saves child danger'
        'girl fights back bully'
        'mother confronts bully'
    )
    searchSection = '/video'
    videoSearchSorting = 'MOST_LIKED'
    videoSearchDateFilter = 'ALL_TIME'
    resultsPerPage = 20
    shouldDownloadVideos = $false
    shouldDownloadCovers = $false
    shouldDownloadAvatars = $false
    shouldDownloadMusicCovers = $false
    scrapeRelatedSearchWords = $false
    commentsPerPost = 0
    downloadSubtitlesOptions = 'NEVER_DOWNLOAD_SUBTITLES'
}

$inputJson = $inputObject | ConvertTo-Json -Depth 5
$run = Invoke-RestMethod -Method Post `
    -Uri 'https://api.apify.com/v2/acts/GdWCkxBtKWOsKjdch/runs?waitForFinish=120' `
    -Headers $headers `
    -Body $inputJson `
    -TimeoutSec 150

[pscustomobject]@{
    status = $run.data.status
    runId = $run.data.id
    datasetId = $run.data.defaultDatasetId
    message = $run.data.statusMessage
} | ConvertTo-Json -Compress
