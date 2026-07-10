param(
  [string]$SourceDir = "",
  [string]$DestDir = "",
  [int]$Width = 1280,
  [int]$Height = 720
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not $SourceDir) { $SourceDir = Join-Path $root 'testCollection\transparent' }
if (-not $DestDir) { $DestDir = Join-Path $root 'testCollection\transparent_1280x720' }

$SourceDir = (Resolve-Path $SourceDir).Path
$DestDir = [System.IO.Path]::GetFullPath($DestDir)

if (-not (Test-Path $SourceDir)) {
  throw "Source directory not found: $SourceDir"
}

New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
Add-Type -AssemblyName System.Drawing

$imageExts = @('.jpg', '.jpeg', '.png', '.bmp', '.webp')
$files = Get-ChildItem $SourceDir -File | Where-Object { $imageExts -contains $_.Extension.ToLower() }
$manifest = New-Object System.Collections.Generic.List[object]
$failed = New-Object System.Collections.Generic.List[object]

foreach ($file in $files) {
  $outPath = Join-Path $DestDir $file.Name
  try {
    $img = [System.Drawing.Image]::FromFile($file.FullName)
    try {
      $srcW = $img.Width
      $srcH = $img.Height
      $bmp = New-Object System.Drawing.Bitmap $Width, $Height
      try {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
          $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
          $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
          $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
          $g.DrawImage($img, 0, 0, $Width, $Height)
        } finally {
          $g.Dispose()
        }
        $ext = $file.Extension.ToLower()
        if ($ext -eq '.png') {
          $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
        } else {
          $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
          $encParams = New-Object System.Drawing.Imaging.EncoderParameters 1
          $encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, 90)
          $bmp.Save($outPath, $codec, $encParams)
        }
      } finally {
        $bmp.Dispose()
      }
    } finally {
      $img.Dispose()
    }
    $outItem = Get-Item $outPath
    $manifest.Add([pscustomobject]@{
      source = $file.FullName
      output = $outPath
      source_size = "${srcW}x${srcH}"
      output_size = "${Width}x${Height}"
      source_bytes = $file.Length
      output_bytes = $outItem.Length
    }) | Out-Null
    Write-Host "OK $($file.Name) ${srcW}x${srcH} -> ${Width}x${Height}"
  } catch {
    $failed.Add([pscustomobject]@{ file = $file.FullName; error = $_.Exception.Message }) | Out-Null
    Write-Warning "FAIL $($file.Name): $($_.Exception.Message)"
  }
}

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$reportDir = Join-Path (Join-Path $root 'reports') "transparent_resize_$stamp"
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null

$manifestPath = Join-Path $reportDir 'manifest.jsonl'
foreach ($row in $manifest) {
  ($row | ConvertTo-Json -Compress) | Add-Content -Path $manifestPath -Encoding UTF8
}

$report = [pscustomobject]@{
  task = 'resize_transparent_to_720p'
  created_at = (Get-Date).ToString('o')
  source_dir = $SourceDir
  dest_dir = $DestDir
  target_size = "${Width}x${Height}"
  total_source_files = $files.Count
  resized_ok = $manifest.Count
  failed = $failed.Count
  failed_items = $failed
}
$reportPath = Join-Path $reportDir 'report.json'
$report | ConvertTo-Json -Depth 5 | Set-Content -Path $reportPath -Encoding UTF8

Write-Host ""
Write-Host "Done: $($manifest.Count) / $($files.Count) -> $DestDir"
Write-Host "Report: $reportPath"
