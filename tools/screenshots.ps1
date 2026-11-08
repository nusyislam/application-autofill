# Store assets, rendered in headless Edge from the sources in store\src (fake data, fictional companies):
#   store\screenshot-1-fill.png     1280x800  a filled application page: outlines and the Done toast (store\src\fill-demo.html
#                                             filled by the real content scripts, like a test fixture)
#   store\screenshot-2-options.png  1280x800  the Options page (options.html with a chrome.storage stub, store\src\options-stub.js)
#   store\screenshot-3-learned.png  1280x800  the learned-answers review (the same page, only that section)
#   store\promo-small-440x280.png   440x280   the small promo tile (store\src\promo-tile.html)
#   icons\icon128.png, icon48.png, icon32.png, icon16.png  from icons\source.png (git-ignored; the top-right tile of the
#                                             2x2 sheet) when present, else from the existing icon128 (store\src\icons.html, a
#                                             canvas: 48 / 128 scaled, 16 / 32 redrawn as vectors); store\.build\icon-sheet.png
#                                             shows every size at 1x and magnified
#
#   powershell -ExecutionPolicy Bypass -File tools\screenshots.ps1
#
# Build pages go to store\.build (git-ignored). Every PNG's size is read back from its header and printed; a wrong size
# fails the run (exit 1).

param([int]$BudgetMs = 60000)

$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
$store = Join-Path $repo "store"
$build = Join-Path $store ".build"
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw "Microsoft Edge not found" }
Remove-Item -Recurse -Force $build -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $build | Out-Null
# Edge's throwaway profiles go to the temp folder, never under the repository: Edge writes the Windows user name and
# other personal strings into them ("Secure Preferences"), which the privacy check would (rightly) flag.
$profiles = Join-Path $env:TEMP "aaf-screenshots"
Remove-Item -Recurse -Force $profiles -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $profiles | Out-Null

function FileUrl($path) { "file:///" + (($path -replace '\\', '/') -replace ' ', '%20') }

# Edge's own stderr chatter must not stop the run (Windows PowerShell 5.1 turns it into a terminating error under "Stop").
function Edge([string[]]$edgeArgs) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $out = & $edge --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --no-first-run --no-default-browser-check --allow-file-access-from-files @edgeArgs 2>$null | Out-String
  $ErrorActionPreference = $prev
  $out
}
function Shot($page, $out, $w, $h) {
  $userData = Join-Path $profiles ("edge-" + [IO.Path]::GetFileNameWithoutExtension($out))
  Edge @("--user-data-dir=$userData", "--window-size=$w,$h", "--virtual-time-budget=$BudgetMs", "--screenshot=$out", (FileUrl $page)) | Out-Null
  if (-not (Test-Path $out)) { throw "no screenshot written: $out" }
}
function PngSize($file) {
  $b = [IO.File]::ReadAllBytes($file)
  $w = ([int]$b[16] -shl 24) -bor ([int]$b[17] -shl 16) -bor ([int]$b[18] -shl 8) -bor [int]$b[19]
  $h = ([int]$b[20] -shl 24) -bor ([int]$b[21] -shl 16) -bor ([int]$b[22] -shl 8) -bor [int]$b[23]
  "$w x $h"
}
$failed = 0
function Check($file, $want) {
  $got = PngSize $file
  if ($got -eq $want) { Write-Host "  $([IO.Path]::GetFileName($file)): $got" -ForegroundColor Green }
  else { Write-Host "  $([IO.Path]::GetFileName($file)): $got, wanted $want" -ForegroundColor Red; $script:failed++ }
}

# 1. The filled application page: the Greenhouse content-script entry in manifest order (like tests\run.ps1), detect()
#    forced (file:// has no portal hostname), and the Done toast function wrapped so the page can show it again after
#    the fill (it closes itself after 10 s of the run's virtual time).
$manifest = Get-Content (Join-Path $repo "manifest.json") -Raw | ConvertFrom-Json
$entry = $manifest.content_scripts | Where-Object { $_.js -contains "adapters/greenhouse.js" } | Select-Object -First 1
$tags = foreach ($js in $entry.js) {
  if ($js -eq "shared/main.js") { "<script>for (const a of Object.values(AAF.adapters)) a.detect = () => true;</script>" }
  "<script src=""$(FileUrl (Join-Path $repo $js))""></script>"
  if ($js -eq "shared/donetoast.js") { "<script>(() => { const o = globalThis.AAF_DONE_TOAST; window.__toastFn = o; globalThis.AAF_DONE_TOAST = (d, p) => { window.__toastData = d; return o(d, p); }; })();</script>" }
}
$page = Join-Path $build "fill-demo.html"
[IO.File]::WriteAllText($page, [IO.File]::ReadAllText((Join-Path $store "src\fill-demo.html")).Replace("<!--SCRIPTS-->", ($tags -join "`n")))
Shot $page (Join-Path $store "screenshot-1-fill.png") 1280 800

# 2 + 3. The Options page with the storage stub, twice: the top of the page, and the learned-answers section alone.
$opts = [IO.File]::ReadAllText((Join-Path $repo "options.html"))
foreach ($kind in "options", "learned") {
  $html = $opts.Replace('<script src="shared/learnrules.js"></script>', "<script>window.__shot = '$kind';</script><script src=""$(FileUrl (Join-Path $store 'src\options-stub.js'))""></script><script src=""$(FileUrl (Join-Path $repo 'shared\learnrules.js'))""></script>")
  $html = $html.Replace('<script src="shared/prefmap.js"></script>', "<script src=""$(FileUrl (Join-Path $repo 'shared\prefmap.js'))""></script>")
  $html = $html.Replace('<script src="options.js"></script>', "<script src=""$(FileUrl (Join-Path $repo 'options.js'))""></script>")
  if ($html -eq $opts) { throw "options.html script tags not found" }
  $page = Join-Path $build "options-$kind.html"
  [IO.File]::WriteAllText($page, $html)
  $n = if ($kind -eq "options") { "2-options" } else { "3-learned" }
  Shot $page (Join-Path $store "screenshot-$n.png") 1280 800
}

# 4. Icon sizes: the canvas page prints each size's PNG as a data URL.
$dom = Edge @("--user-data-dir=$profiles\edge-icons", "--virtual-time-budget=5000", "--dump-dom", (FileUrl (Join-Path $store "src\icons.html")))
$m = [regex]::Match($dom, '@@BEGIN\r?\n([\s\S]*?)\r?\n@@END')
if (-not $m.Success) { throw "icons.html printed nothing" }
foreach ($line in ($m.Groups[1].Value -split "\r?\n")) {
  $parts = $line.Split(" ", 2)
  $size = $parts[0]
  $b64 = ($parts[1] -replace '^data:image/png;base64,', '')
  $dest = if ($size -eq "sheet") { Join-Path $build "icon-sheet.png" } else { Join-Path $repo "icons\icon$size.png" }
  [IO.File]::WriteAllBytes($dest, [Convert]::FromBase64String($b64))
}

# 5. The small promo tile (after the icons: it shows icons/icon128.png).
Shot (Join-Path $store "src\promo-tile.html") (Join-Path $store "promo-small-440x280.png") 440 280

Write-Host "written:"
Check (Join-Path $store "screenshot-1-fill.png") "1280 x 800"
Check (Join-Path $store "screenshot-2-options.png") "1280 x 800"
Check (Join-Path $store "screenshot-3-learned.png") "1280 x 800"
Check (Join-Path $store "promo-small-440x280.png") "440 x 280"
foreach ($s in 16, 32, 48, 128) { Check (Join-Path $repo "icons\icon$s.png") "$s x $s" }
Remove-Item -Recurse -Force $profiles -ErrorAction SilentlyContinue
if ($failed) { Write-Host "$failed file(s) have the wrong size" -ForegroundColor Red; exit 1 }
