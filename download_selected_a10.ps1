$ErrorActionPreference = 'Stop'
$apifyToken = (Get-Clipboard -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($apifyToken)) { throw 'Clipboard is empty.' }
$headers = @{ Authorization = "Bearer $apifyToken"; 'Content-Type' = 'application/json' }

$selectedUrls = @(
    'https://www.tiktok.com/@tacticoolmama/video/7632409512388889870'
    'https://www.tiktok.com/@pms_shopping/video/6893883722991406341'
    'https://www.tiktok.com/@girlwithdaburger/video/7669812441273945364'
    'https://www.tiktok.com/@ilovecupcakesyum111/video/7593979120288025886'
    'https://www.tiktok.com/@lexx.b.golden/video/7663517168880880910'
    'https://www.tiktok.com/@lilbitmaxwell/video/7618513642979347742'
    'https://www.tiktok.com/@storiesofjasveen/video/7529874027972660502'
    'https://www.tiktok.com/@slavetothetrigger/video/7229765523586698539'
    'https://www.tiktok.com/@dontcopyme215/video/7626513345880853774'
    'https://www.tiktok.com/@.almondnilla/video/7548268768275811639'
)

$inputObject = @{
    postURLs = $selectedUrls
    resultsPerPage = 10
    shouldDownloadVideos = $true
    shouldDownloadCovers = $false
    shouldDownloadAvatars = $false
    shouldDownloadMusicCovers = $false
    commentsPerPost = 0
    downloadSubtitlesOptions = 'NEVER_DOWNLOAD_SUBTITLES'
}
$inputJson = $inputObject | ConvertTo-Json -Depth 5
$run = Invoke-RestMethod -Method Post `
    -Uri 'https://api.apify.com/v2/acts/GdWCkxBtKWOsKjdch/runs?waitForFinish=180' `
    -Headers $headers -Body $inputJson -TimeoutSec 210
[pscustomobject]@{
    status = $run.data.status
    runId = $run.data.id
    datasetId = $run.data.defaultDatasetId
    storeId = $run.data.defaultKeyValueStoreId
    message = $run.data.statusMessage
} | ConvertTo-Json -Compress
