# packages/web のビルド結果(dist)が最新かどうかを判定する。
#
# 終了コード
#   1 = ビルドが必要（dist が無い / ソースが dist より新しい / 判定できなかった）
#   0 = dist は最新なのでビルド不要
#
# 判定できないときは「必要」側に倒す。古い画面を配信し続けるより、
# 余分にビルドするほうが安全なため。

$ErrorActionPreference = "Stop"

try {
    $root = Split-Path -Parent $PSScriptRoot
    $web = Join-Path $root "packages\web"
    $target = Join-Path $web "dist\index.html"

    if (-not (Test-Path $target)) {
        Write-Host "[build-check] dist がまだありません。ビルドします。"
        exit 1
    }
    $builtAt = (Get-Item $target).LastWriteTime

    # ビルド結果に影響するものだけを対象にする。
    # .env* も含める（VITE_API_BASE_URL の値がバンドルに埋め込まれるため）。
    $paths = @(
        (Join-Path $web "src")
        (Join-Path $web "public")
        (Join-Path $web "index.html")
        (Join-Path $web "package.json")
        (Join-Path $web "tsconfig.json")
        (Join-Path $web "vite.config.ts")
        (Join-Path $web "vite.config.js")
        (Join-Path $web "vite.config.mts")
    )
    $paths += (Get-ChildItem -Path $web -Filter ".env*" -File -Force -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty FullName)

    $newest = $null
    foreach ($p in $paths) {
        if (-not (Test-Path $p)) { continue }
        $items = if ((Get-Item $p).PSIsContainer) {
            Get-ChildItem -Path $p -Recurse -File -Force
        } else {
            Get-Item $p
        }
        foreach ($item in $items) {
            if ($null -eq $newest -or $item.LastWriteTime -gt $newest.LastWriteTime) { $newest = $item }
        }
    }

    if ($null -eq $newest) {
        Write-Host "[build-check] 比較対象のソースが見つかりません。念のためビルドします。"
        exit 1
    }

    if ($newest.LastWriteTime -gt $builtAt) {
        $changed = $newest.FullName.Substring($root.Length).TrimStart("\")
        Write-Host "[build-check] 更新あり: $changed"
        Write-Host ("[build-check]   source {0:yyyy-MM-dd HH:mm:ss}  >  dist {1:yyyy-MM-dd HH:mm:ss}" -f $newest.LastWriteTime, $builtAt)
        exit 1
    }

    Write-Host ("[build-check] dist は最新です (built {0:yyyy-MM-dd HH:mm:ss})。ビルドを省略します。" -f $builtAt)
    exit 0
}
catch {
    Write-Host "[build-check] 判定に失敗しました: $($_.Exception.Message)"
    Write-Host "[build-check] 念のためビルドします。"
    exit 1
}
