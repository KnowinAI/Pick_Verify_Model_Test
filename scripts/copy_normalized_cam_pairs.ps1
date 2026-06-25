
param(
  [Parameter(Mandatory = $true)]
  [string[]]$InputDirectories,

  [Parameter(Mandatory = $true)]
  [string]$OutputRoot
)

Write-Host "Strict stereo pairing (FIXED timestamp + suffix) START"

$files = @()

foreach ($dir in $InputDirectories) {
  if (Test-Path $dir) {
    $files += Get-ChildItem -Path $dir -Recurse -File
  }
}

Write-Host "Total files: $($files.Count)"

# support both realtime_cam0_... and cam0_...
$pattern = "(realtime_)?cam(?<cam>[01])_(?<ts>\d{14})_(?<suffix>[A-Za-z0-9]+)\.(jpg|jpeg|png)"

$cam0 = @()
$cam1 = @()

foreach ($f in $files) {
  if ($f.Name -match $pattern) {

    $cam = $matches.cam
    $ts = $matches.ts   # KEEP AS STRING (DO NOT CAST)
    $suffix = $matches.suffix

    $obj = [pscustomobject]@{
      path = $f.FullName
      ts = $ts
      suffix = $suffix
      time = $f.LastWriteTime
    }

    if ($cam -eq "0") { $cam0 += $obj }
    else { $cam1 += $obj }
  }
}

$used0 = New-Object System.Collections.Generic.HashSet[string]
$planned = New-Object System.Collections.Generic.List[object]

foreach ($c1 in $cam1) {

  $best = $null
  $bestDiff = 999999999

  foreach ($c0 in $cam0) {

    if ($used0.Contains($c0.path)) { continue }

    $diff = [math]::Abs(([int64]$c1.ts - [int64]$c0.ts))

    if ($diff -lt $bestDiff) {
      $bestDiff = $diff
      $best = $c0
    }
  }

  # strict pairing
  if ($best -ne $null -and $bestDiff -le 1) {

    $used0.Add($best.path) | Out-Null

    # ===== FIXED NAMING (NO LOSS OF TIMESTAMP) =====
    $ts = $c1.ts
    $suffix = $c1.suffix

    # NO double underscore logic
    $cam1_name = "cam1_${ts}_${suffix}"
    $cam0_name = "cam0_${ts}_${suffix}"

    $planned.Add([pscustomobject]@{
      cam0_path = $best.path
      cam1_path = $c1.path
      cam0_name = $cam0_name
      cam1_name = $cam1_name
    })
  }
}

$out0 = Join-Path $OutputRoot "cam0"
$out1 = Join-Path $OutputRoot "cam1"

New-Item -ItemType Directory -Force -Path $out0 | Out-Null
New-Item -ItemType Directory -Force -Path $out1 | Out-Null

foreach ($p in $planned) {

  $ext0 = [System.IO.Path]::GetExtension($p.cam0_path)
  $ext1 = [System.IO.Path]::GetExtension($p.cam1_path)

  Copy-Item $p.cam0_path (Join-Path $out0 ($p.cam0_name + $ext0))
  Copy-Item $p.cam1_path (Join-Path $out1 ($p.cam1_name + $ext1))
}

$report = @{
  total_files = $files.Count
  paired = $planned.Count
  rule = "STRICT: ts preserved + suffix preserved + no double underscore + <=1s"
}

$report | ConvertTo-Json | Out-File (Join-Path $OutputRoot "report.json") -Encoding UTF8

Write-Host "DONE. PAIRED: $($planned.Count)"
