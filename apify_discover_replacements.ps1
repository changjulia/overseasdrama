$ErrorActionPreference = 'Stop'
$apifyToken = (Get-Clipboard -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($apifyToken)) { throw 'Clipboard is empty.' }
$headers = @{ Authorization = "Bearer $apifyToken"; 'Content-Type' = 'application/json' }
$inputObject = @{
    searchQueries = @(
        'woman slaps man movie scene'
        'mother shields child movie scene'
        'bride walks away groom scene'
        'woman catches boyfriend cheating caught camera'
        'girl pushes attacker away'
        'woman rescues girl caught camera'
        'mother runs to save child security camera'
        'woman stops bully fight'
    )
    searchSection = '/video'
    videoSearchSorting = 'MOST_LIKED'
    videoSearchDateFilter = 'ALL_TIME'
    resultsPerPage = 30
    shouldDownloadVideos = $false
    shouldDownloadCovers = $false
    shouldDownloadAvatars = $false
    shouldDownloadMusicCovers = $false
    scrapeRelatedSearchWords = $false
    commentsPerPost = 0
    downloadSubtitlesOptions = 'NEVER_DOWNLOAD_SUBTITLES'
}
$run = Invoke-RestMethod -Method Post `
    -Uri 'https://api.apify.com/v2/acts/GdWCkxBtKWOsKjdch/runs?waitForFinish=150' `
    -Headers $headers -Body ($inputObject | ConvertTo-Json -Depth 5) -TimeoutSec 180
[pscustomobject]@{status=$run.data.status;runId=$run.data.id;datasetId=$run.data.defaultDatasetId;message=$run.data.statusMessage} | ConvertTo-Json -Compress
