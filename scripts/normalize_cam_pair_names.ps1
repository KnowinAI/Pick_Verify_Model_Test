param(
  [Parameter(Mandatory = $true)]
  [string]$Directory,

  [switch]$Apply
)

$ErrorActionPreference = 'Stop'

if (!(Test-Path -LiteralPath $Directory)) {
  throw "Directory not found: $Directory"
}

function Parse-RealtimeName {
  param([System.IO.FileInfo]$File)

  if ($File.Name -notmatch '^realtime_cam([01])_(\d{14})(?:_([^.]+))?(\.[^.]+)$') {
    return $null
  }

  [pscustomobject]@{
    File      = $File
    Name      = $File.Name
    Cam       = [int]$matches[1]
    Timestamp = $matches[2]
    Suffix    = $matches[3]
    Extension = $matches[4]
    Time      = [datetime]::ParseExact($matches[2], 'yyyyMMddHHmmss', $null)
  }
}

$items = @(Get-ChildItem -LiteralPath $Directory -File | ForEach-Object { Parse-RealtimeName $_ } | Where-Object { $_ })
$cam0 = @($items | Where-Object Cam -eq 0 | Sort-Object Time, Name)
$cam1 = @($items | Where-Object Cam -eq 1 | Sort-Object Time, Name)

if ($cam0.Count -ne $cam1.Count) {
  throw "Cannot safely pair by order: cam0 count=$($cam0.Count), cam1 count=$($cam1.Count)."
}

$renames = New-Object System.Collections.Generic.List[object]
for ($i = 0; $i -lt $cam0.Count; $i += 1) {
  $left = $cam0[$i]
  $right = $cam1[$i]
  $newCam1Name = "realtime_cam1_$($left.Timestamp)_$($left.Suffix)$($right.Extension)"
  $renames.Add([pscustomobject]@{
    Index       = $i + 1
    Cam0        = $left.Name
    OldCam1     = $right.Name
    NewCam1     = $newCam1Name
    DiffSeconds = [math]::Abs(($right.Time - $left.Time).TotalSeconds)
  })
}

$changes = @($renames | Where-Object { $_.OldCam1 -ne $_.NewCam1 })
$duplicateTargets = @($changes | Group-Object NewCam1 | Where-Object Count -gt 1)
if ($duplicateTargets.Count) {
  throw "Duplicate rename targets detected: $($duplicateTargets[0].Name)"
}

$existingNames = New-Object 'System.Collections.Generic.HashSet[string]'
Get-ChildItem -LiteralPath $Directory -File | ForEach-Object { [void]$existingNames.Add($_.Name) }

$conflicts = @(
  $changes | Where-Object {
    $existingNames.Contains($_.NewCam1) -and $_.OldCam1 -ne $_.NewCam1
  }
)
if ($conflicts.Count) {
  throw "Target already exists: $($conflicts[0].NewCam1)"
}

$summary = [pscustomobject]@{
  Directory         = (Resolve-Path -LiteralPath $Directory).Path
  MatchedFiles      = $items.Count
  PairCount         = $cam0.Count
  RenameCount       = $changes.Count
  MaxDiffSeconds    = if ($renames.Count) { ($renames | Measure-Object DiffSeconds -Maximum).Maximum } else { 0 }
  OverOneSecond     = @($renames | Where-Object { $_.DiffSeconds -gt 1 }).Count
  Apply             = [bool]$Apply
}

if (!$Apply) {
  $summary | ConvertTo-Json -Depth 4
  'PREVIEW_FIRST_20'
  $changes | Select-Object -First 20 | ConvertTo-Json -Depth 4
  return
}

foreach ($rename in $changes) {
  Rename-Item -LiteralPath (Join-Path $Directory $rename.OldCam1) -NewName $rename.NewCam1
}

$summary | ConvertTo-Json -Depth 4
