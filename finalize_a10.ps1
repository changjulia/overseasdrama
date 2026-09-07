$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$finalDir = Join-Path $root 'A类候选\A类合格_10条_20260903'
New-Item -ItemType Directory -Path $finalDir -Force | Out-Null

$sources = @{
    '7618513642979347742' = 'A类候选\本轮10条\01_A8_危险救援_TK_7618513642979347742.mp4'
    '7626513345880853774' = 'A类候选\本轮10条\02_A2_母爱保护_TK_7626513345880853774.mp4'
    '7229765523586698539' = 'A类候选\本轮10条\05_A2_母爱保护_TK_7229765523586698539.mp4'
    '7529874027972660502' = 'A类候选\本轮10条\07_A6_女性逆袭_TK_7529874027972660502.mp4'
    '7593979120288025886' = 'A类候选\本轮10条\09_A5_情感脱离_TK_7593979120288025886.mp4'
    '7548268768275811639' = 'A类候选\本轮10条\10_A6_挺身保护_TK_7548268768275811639.mp4'
    '7299560055752494379' = 'A类候选\补充待审\TK_7299560055752494379.mp4'
    '7621332682936421646' = 'A类候选\补充待审\TK_7621332682936421646.mp4'
    '7493235915805052191' = 'A类候选\补充待审2\TK_7493235915805052191.mp4'
    '7512185677308628229' = 'A类候选\补充待审2\TK_7512185677308628229.mp4'
}
$labels = @{
    '7618513642979347742' = @('A8_危险救援','母子','孩子遇险','恐惧','紧急介入','危险悬念')
    '7626513345880853774' = @('A2_母爱保护','母子','孩子受威胁','愤怒','挺身保护','母爱共情')
    '7229765523586698539' = @('A2_母爱保护','母子','欺凌上门','愤怒','挺身保护','不公激怒')
    '7529874027972660502' = @('A6_女性逆袭','施害者-受害者','校园欺凌','释然','身份反差','逆袭期待')
    '7593979120288025886' = @('A5_情感脱离','恋人','背叛','崩溃','关系决裂','背叛抓包')
    '7548268768275811639' = @('A6_挺身保护','保护者-被保护者','校园欺凌','感动','他人介入','弱者共情')
    '7299560055752494379' = @('A6_家庭反击','姐妹','家人受辱','愤怒','当面对峙','反击期待')
    '7621332682936421646' = @('A6_手足保护','姐弟','弟弟受威胁','愤怒','及时介入','亲情守护')
    '7493235915805052191' = @('A8_危险救援','母子','自然灾害','紧张','抱走孩子','危险悬念')
    '7512185677308628229' = @('A8_危险救援','母子','车辆失控','惊恐','极限救援','生死悬念')
}

$metaFiles = @(
    'A类候选\本轮10条\manifest.json',
    'A类候选\补充待审\metadata.json',
    'A类候选\补充待审2\metadata.json'
)
$meta = @{}
foreach ($mf in $metaFiles) {
    foreach ($row in @(Get-Content -Raw -LiteralPath (Join-Path $root $mf) | ConvertFrom-Json)) {
        $meta[[string]$row.id] = $row
    }
}

$manifest = @()
$i = 0
foreach ($id in $sources.Keys) {
    $i++
    $tag = $labels[$id]
    $category = $tag[0]
    $destName = ('{0:D2}_{1}_TK_{2}.mp4' -f $i, $category, $id)
    Copy-Item -LiteralPath (Join-Path $root $sources[$id]) -Destination (Join-Path $finalDir $destName) -Force
    $m = $meta[$id]
    $manifest += [pscustomobject]@{
        index = $i; id = $id; platform = 'TikTok'; file_name = $destName
        duration_seconds = if ($m.duration_seconds) {$m.duration_seconds} else {$m.duration}
        likes = $m.likes; comments = $m.comments; shares = $m.shares
        source_url = if ($m.source_url) {$m.source_url} else {$m.url}
        material_class = 'A'; source_class = 'external_material'
        hook_source_status = '待人工确认'; hook_assembly_type = '跨剧外搭'; hook_type = '纯截停型'; audience = '女性向'
        subtype = $tag[0]; relation = $tag[1]; conflict = $tag[2]; emotion = $tag[3]; storyBeat = $tag[4]; acquisition = $tag[5]
        genre = ''; theme = ''; review_status = '画面初审通过_待入库复核'
    }
}
$manifest = $manifest | Sort-Object index
$manifest | Export-Csv -LiteralPath (Join-Path $finalDir 'manifest.csv') -NoTypeInformation -Encoding utf8
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $finalDir 'manifest.json') -Encoding utf8
[pscustomobject]@{count=@(Get-ChildItem -LiteralPath $finalDir -Filter '*.mp4').Count;directory=$finalDir;minLikes=($manifest|Measure-Object likes -Minimum).Minimum;maxDuration=($manifest|Measure-Object duration_seconds -Maximum).Maximum} | ConvertTo-Json -Compress
