$ErrorActionPreference = 'Stop'
$apifyToken = (Get-Clipboard -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($apifyToken)) { throw 'Clipboard is empty.' }
$headers = @{ Authorization = "Bearer $apifyToken" }
$datasetId = 'vm5zmKuUOYMzobgnE'
$items = Invoke-RestMethod -Method Get -Uri "https://api.apify.com/v2/datasets/$datasetId/items?clean=true&limit=100" -Headers $headers -TimeoutSec 90
$outDir = Join-Path $PSScriptRoot 'A类候选\本轮10条'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$categoryById = @{
    '7632409512388889870' = 'A2_母爱保护'
    '6893883722991406341' = 'A3_不公欺凌'
    '7669812441273945364' = 'A3_不公欺凌'
    '7593979120288025886' = 'A5_情感脱离'
    '7663517168880880910' = 'A5_母女情感'
    '7618513642979347742' = 'A8_危险救援'
    '7529874027972660502' = 'A6_女性逆袭'
    '7229765523586698539' = 'A2_母爱保护'
    '7626513345880853774' = 'A2_母爱保护'
    '7548268768275811639' = 'A6_挺身保护'
}

$manifest = @()
$index = 0
foreach ($item in $items) {
    $index++
    $id = [string]$item.id
    $category = $categoryById[$id]
    if (-not $category) { $category = 'A_待细分' }
    $safeCategory = $category -replace '[\\/:*?"<>|]', '_'
    $fileName = ('{0:D2}_{1}_TK_{2}.mp4' -f $index, $safeCategory, $id)
    $outFile = Join-Path $outDir $fileName
    $downloadUrl = [string]$item.videoMeta.downloadAddr
    if ([string]::IsNullOrWhiteSpace($downloadUrl)) { throw "No download URL for $id" }
    Invoke-WebRequest -Uri $downloadUrl -Headers $headers -OutFile $outFile -TimeoutSec 180
    $file = Get-Item -LiteralPath $outFile
    if ($file.Length -le 0) { throw "Empty download for $id" }
    $manifest += [pscustomobject]@{
        index = $index
        id = $id
        platform = 'TikTok'
        category = $category
        duration_seconds = [math]::Round([double]$item.videoMeta.duration, 3)
        likes = [long]$item.diggCount
        comments = [long]$item.commentCount
        shares = [long]$item.shareCount
        plays = [long]$item.playCount
        source_url = $item.webVideoUrl
        caption = $item.text
        file_name = $fileName
        file_bytes = $file.Length
        source_class = 'external_material'
        material_class = 'A'
        hook_type = '纯截停型'
        audience = '女性向'
        review_status = '待人工复核'
    }
}
$manifest | Export-Csv -LiteralPath (Join-Path $outDir 'manifest.csv') -NoTypeInformation -Encoding utf8
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $outDir 'manifest.json') -Encoding utf8
[pscustomobject]@{
    downloaded = $manifest.Count
    directory = $outDir
    totalBytes = ($manifest | Measure-Object file_bytes -Sum).Sum
    minLikes = ($manifest | Measure-Object likes -Minimum).Minimum
    maxDuration = ($manifest | Measure-Object duration_seconds -Maximum).Maximum
} | ConvertTo-Json -Compress
