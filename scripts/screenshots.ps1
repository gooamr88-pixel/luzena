# Captures every page at phone and desktop widths with headless Chrome, for visual review.
# Usage:  npm run build:demo; npx vite preview --port 4317 --host 127.0.0.1   (in another terminal)
#         powershell -File scripts/screenshots.ps1
# The server must be bound to 127.0.0.1: by default Vite listens on IPv6 only, which
# headless Chrome on Windows does not reach through "localhost".
param(
  [string]$Base = "http://127.0.0.1:4317",
  [string]$Out = (Join-Path $PSScriptRoot "..\.visual"),
  [string[]]$Only = @()
)

$chrome = Get-ChildItem "$env:LOCALAPPDATA\ms-playwright" -Recurse -Filter "chrome-headless-shell.exe" -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $chrome) { throw "No headless Chrome found under $env:LOCALAPPDATA\ms-playwright" }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
# `-File script.ps1 -Only a,b` passes "a,b" as one string, so split it here.
$Only = @($Only | ForEach-Object { $_ -split "," } | Where-Object { $_ })

$pages = [ordered]@{
  "home" = "/"; "menu" = "/menu/"; "about" = "/about/"; "locations" = "/locations/"; "gallery" = "/gallery/"
  "contact" = "/contact/"; "careers" = "/careers/"; "order" = "/order/"; "notfound" = "/404.html"
  "dash-overview" = "/dashboard/#/"; "dash-items" = "/dashboard/#/items"; "dash-item-edit" = "/dashboard/#/items/SAMPLEITEM005"
  "dash-item-new" = "/dashboard/#/items/new"; "dash-categories" = "/dashboard/#/categories"
  "dash-modifiers" = "/dashboard/#/modifiers"; "dash-clover" = "/dashboard/#/clover"; "dash-activity" = "/dashboard/#/activity"
}
$sizes = [ordered]@{ "mobile" = "390,2600"; "desktop" = "1440,2400" }

foreach ($name in $pages.Keys) {
  if ($Only.Count -gt 0 -and $Only -notcontains $name) { continue }
  foreach ($size in $sizes.Keys) {
    $file = Join-Path $Out "$name-$size.png"
    if (Test-Path $file) { Remove-Item $file }
    # Each capture gets its own throwaway profile and a hard time limit, so one stuck
    # browser cannot hold up the rest.
    $profile = Join-Path $env:TEMP "luzna-shot-$([guid]::NewGuid().ToString('N'))"
    $arguments = @("--headless", "--disable-gpu", "--hide-scrollbars", "--no-sandbox", "--user-data-dir=`"$profile`"",
      "--window-size=$($sizes[$size])", "--virtual-time-budget=6000", "--screenshot=`"$file`"", "$Base$($pages[$name])")
    $process = Start-Process -FilePath $chrome -ArgumentList $arguments -PassThru -WindowStyle Hidden
    if (-not $process.WaitForExit(90000)) { $process.Kill(); Write-Output "$name-$size.png TIMED OUT" }
    elseif (Test-Path $file) { Write-Output "$name-$size.png" }
    else { Write-Output "$name-$size.png FAILED" }
    Remove-Item -Recurse -Force $profile -ErrorAction SilentlyContinue
  }
}
