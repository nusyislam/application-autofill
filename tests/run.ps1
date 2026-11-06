# Before/after regression check for the content scripts, in headless Edge.
#
#   powershell -ExecutionPolicy Bypass -File tests\run.ps1                 # compare the last commit (HEAD) vs working tree
#   powershell -ExecutionPolicy Bypass -File tests\run.ps1 -Before HEAD~1 # compare against another commit or tag
#   powershell -ExecutionPolicy Bypass -File tests\run.ps1 -Only greenhouse # only fixtures starting with "greenhouse"
#
# Each tests/fixtures/<adapter>-<name>.html is a fake portal page with a stubbed `chrome` API (profile in
# chrome.storage, canned Claude answers) and a <!--SCRIPTS--> placeholder. The runner fills the placeholder
# with that tree's content scripts in manifest order (the content_scripts entry containing
# adapters/<adapter>.js), forces the adapter's detect() to true (file:// has no portal hostname), runs a
# fill, and reads back the page's report: stats, every [autofill] log line, each field's final value and
# outline. Timings ("N ms") are masked before diffing. A fixture whose adapter doesn't exist in the
# "before" tree is run on the working tree only and printed.

param([string]$Before = "HEAD", [string]$Only = "", [int]$BudgetMs = 1800000)

$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
$out = Join-Path $PSScriptRoot ".out"
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw "Microsoft Edge not found" }

# Privacy check: no file in the working tree may hold your personal data (tests/privacy-check.js: every tracked file
# plus untracked, not ignored ones, against the strings in tests\private-patterns.txt, git-ignored; a hit is reported by
# file, line and pattern number, never the text). A hit stops the run. The pre-commit hook (tests/hooks/pre-commit)
# runs the same check on the staged content.
& node (Join-Path $PSScriptRoot "privacy-check.js")
if ($LASTEXITCODE -ne 0) { exit 1 }

Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$out\before" | Out-Null
# Export the "before" tree (tar ships with Windows 10+).
git -C $repo archive --format=tar -o "$out\before.tar" $Before
if ($LASTEXITCODE) { throw "git archive $Before failed" }
tar -xf "$out\before.tar" -C "$out\before"

function FileUrl($path) { "file:///" + (($path -replace '\\', '/') -replace ' ', '%20') }

function Build-Page($fixture, $tree, $adapter, $dest) {
  $manifest = Get-Content (Join-Path $tree "manifest.json") -Raw | ConvertFrom-Json
  $entry = $manifest.content_scripts | Where-Object { $_.js -contains "adapters/$adapter.js" } | Select-Object -First 1
  if (-not $entry) { return $false }
  $tags = foreach ($js in $entry.js) {
    if ($js -eq "shared/main.js") { "<script>for (const a of Object.values(AAF.adapters)) a.detect = () => true; // file:// has no portal hostname</script>" }
    "<script src=""$(FileUrl (Join-Path $tree $js))""></script>"
  }
  $html = [IO.File]::ReadAllText($fixture).Replace("<!--SCRIPTS-->", ($tags -join "`n"))
  [IO.File]::WriteAllText($dest, $html)
  return $true
}

function Run-Page($page, $profileDir) {
  # Edge's own stderr chatter (sync / network errors) must not stop the run: under "Stop", Windows
  # PowerShell 5.1 turns a native command's stderr line into a terminating error, even with 2>$null.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $dom = & $edge --headless=new --disable-gpu --no-first-run --no-default-browser-check --allow-file-access-from-files "--user-data-dir=$profileDir" "--virtual-time-budget=$BudgetMs" --dump-dom (FileUrl $page) 2>$null | Out-String
  $ErrorActionPreference = $prev
  $m = [regex]::Match($dom, '@@BEGIN\r?\n([\s\S]*?)\r?\n@@END')
  if ($m.Success) { [System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value) } else { "NO OUTPUT (page never reported; check for a script error)" }
}

$mask = { param($t) ($t -replace '\d+ ms', 'N ms') -split "\r?\n" }
$failed = 0
foreach ($fx in Get-ChildItem (Join-Path $PSScriptRoot "fixtures") -Filter *.html | Where-Object { $_.Name -like "$Only*" -and $_.Name -notlike "*-raw.html" }) {
  $adapter = $fx.BaseName.Split("-")[0]
  $name = $fx.BaseName
  $results = @{}
  foreach ($side in "before", "after") {
    $tree = if ($side -eq "before") { "$out\before" } else { $repo }
    $page = "$out\$name.$side.html"
    if (Build-Page $fx.FullName $tree $adapter $page) {
      $results[$side] = Run-Page $page "$out\edge-$name-$side"
      [IO.File]::WriteAllText("$out\$name.$side.txt", $results[$side])
    }
  }
  $errs = @(($results["after"] -split "\r?\n") | Where-Object { $_ -match "^ERR|^NO OUTPUT" })
  if (-not $results.ContainsKey("before")) {
    Write-Host "===== $name : new (no '$adapter' adapter in $Before), working tree output:" -ForegroundColor Cyan
    $results["after"]
  } else {
    $diff = Compare-Object (& $mask $results["before"]) (& $mask $results["after"]) -SyncWindow 0
    if ($diff) {
      $failed++
      Write-Host "===== $name : DIFFERS from $Before" -ForegroundColor Yellow
      $diff | Format-Table -AutoSize -Wrap | Out-String -Width 220
    } else {
      Write-Host "===== $name : identical to $Before ($((& $mask $results['after']).Count) lines)" -ForegroundColor Green
    }
  }
  if ($errs.Count) { $failed++; Write-Host "  script errors:" -ForegroundColor Red; $errs }
}
if ($failed) { Write-Host "$failed fixture(s) differ or errored" -ForegroundColor Yellow } else { Write-Host "all fixtures OK" -ForegroundColor Green }

# background.js request bodies (tests\bg-request.js, Node): no sampling parameters (temperature / top_p / top_k) on any
# Claude call, and an HTTP 400 reported as a rejected request. A failure fails the run (exit 1).
& node (Join-Path $PSScriptRoot "bg-request.js")
if ($LASTEXITCODE -ne 0) { Write-Host "background request check failed" -ForegroundColor Red; exit 1 }

# The regression corpus: tests\expected.txt holds, for every real-page failure, the answer the field must end with.
# One per line: <fixture> :: <start of its FIELD line> => <text that line must contain> ("#" starts a comment). Checked
# against the working tree's output; any miss fails the run (exit 1), unlike before / after differences.
$expFile = Join-Path $PSScriptRoot "expected.txt"
if (Test-Path $expFile) {
  $expFailed = 0
  $expChecked = 0
  foreach ($line in [IO.File]::ReadAllLines($expFile)) {
    if (-not $line.Trim() -or $line.TrimStart().StartsWith("#")) { continue }
    $m = [regex]::Match($line, '^\s*(\S+)\s*::\s*(.+?)\s*=>\s*(.+?)\s*$')
    if (-not $m.Success) { Write-Host "expected.txt: can't read `"$line`"" -ForegroundColor Yellow; continue }
    $fxName = $m.Groups[1].Value
    if ($Only -and -not $fxName.StartsWith($Only)) { continue }
    $start = $m.Groups[2].Value
    $want = $m.Groups[3].Value
    $expChecked++
    $file = "$out\$fxName.after.txt"
    if (-not (Test-Path $file)) { $expFailed++; Write-Host "EXPECT FAIL $fxName : the fixture didn't run" -ForegroundColor Red; continue }
    # "!LOG => <text>": no log line may contain the text (a question that must be answered, never "left for you").
    if ($start -eq "!LOG") {
      $bad = [IO.File]::ReadAllLines($file) | Where-Object { $_.StartsWith("LOG ") -and $_.Contains($want) } | Select-Object -First 1
      if ($bad) { $expFailed++; Write-Host "EXPECT FAIL $fxName :: no log line with `"$want`"" -ForegroundColor Red; Write-Host "   got: $bad" }
      continue
    }
    $hit =[IO.File]::ReadAllLines($file) | Where-Object { $_.StartsWith("FIELD $start") } | Select-Object -First 1
    if (-not $hit -or -not $hit.Contains($want)) {
      $expFailed++
      Write-Host "EXPECT FAIL $fxName :: $start => $want" -ForegroundColor Red
      Write-Host "   got: $(if ($hit) { $hit } else { '(no such field)' })"
    }
  }
  if ($expFailed) {
    Write-Host "regression corpus: $expFailed of $expChecked expected answers wrong" -ForegroundColor Red
    exit 1
  }
  Write-Host "regression corpus: all $expChecked expected answers OK" -ForegroundColor Green
}
