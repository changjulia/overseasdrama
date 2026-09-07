$ErrorActionPreference = 'Stop'
$apifyToken = (Get-Clipboard -Raw).Trim()
$headers = @{ Authorization = "Bearer $apifyToken" }
$items = Invoke-RestMethod -Method Get -Uri 'https://api.apify.com/v2/datasets/vsTpg3bqEd4aCGYSu/items?clean=true&limit=20' -Headers $headers -TimeoutSec 90
$outDir = Join-Path $PSScriptRoot 'A类候选\补充待审2'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$records = @()
foreach ($item in $items) {
    $id = [string]$item.id
    $file = Join-Path $outDir ("TK_$id.mp4")
    Invoke-WebRequest -Uri ([string]$item.videoMeta.downloadAddr) -Headers $headers -OutFile $file -TimeoutSec 180
    $records += [pscustomobject]@{id=$id;duration=$item.videoMeta.duration;likes=$item.diggCount;comments=$item.commentCount;shares=$item.shareCount;url=$item.webVideoUrl;text=$item.text;file=$file}
}
$records | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $outDir 'metadata.json') -Encoding utf8
[pscustomobject]@{downloaded=$records.Count;directory=$outDir} | ConvertTo-Json -Compress
