$ErrorActionPreference = 'Stop'
$apifyToken = (Get-Clipboard -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($apifyToken)) { throw 'Clipboard is empty.' }
$headers = @{ Authorization = "Bearer $apifyToken" }
$datasetId = 'qdxMb1vYZzoMdy2oS'
$uri = "https://api.apify.com/v2/datasets/$datasetId/items?clean=true&limit=1000"
$items = Invoke-RestMethod -Method Get -Uri $uri -Headers $headers -TimeoutSec 90
$qualified = @($items | Where-Object {
    $_.videoMeta -and
    [double](@($_.videoMeta.duration)[0]) -le 15 -and
    [long](@($_.diggCount)[0]) -ge 50000 -and
    $_.webVideoUrl
} | Group-Object id | ForEach-Object { $_.Group[0] } |
    Sort-Object @{Expression={[long](@($_.shareCount)[0])};Descending=$true}, @{Expression={[long](@($_.commentCount)[0])};Descending=$true}, @{Expression={[long](@($_.diggCount)[0])};Descending=$true})
$outDir = Join-Path $PSScriptRoot 'A类候选'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$qualified | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $outDir 'replacement2_qualified_metadata.json') -Encoding utf8
[pscustomobject]@{
    fetched = $items.Count
    qualified = $qualified.Count
    top = @($qualified | Select-Object -First 15 | ForEach-Object {
        [pscustomobject]@{
            id = $_.id
            duration = $_.videoMeta.duration
            likes = $_.diggCount
            comments = $_.commentCount
            shares = $_.shareCount
            text = $_.text
            url = $_.webVideoUrl
        }
    })
} | ConvertTo-Json -Depth 6
