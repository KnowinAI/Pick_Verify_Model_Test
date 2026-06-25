$ErrorActionPreference = 'SilentlyContinue'

function Test-PrivateIPv4 {
  param([string] $Address)

  if (-not $Address) { return $false }
  if ($Address -match '^(127|169\.254)\.') { return $false }
  if ($Address -match '^10\.') { return $true }
  if ($Address -match '^192\.168\.') { return $true }
  if ($Address -match '^172\.(1[6-9]|2[0-9]|3[0-1])\.') { return $true }
  return $false
}

function Get-AdapterScore {
  param([string] $Header, [string] $Address, [bool] $HasGateway)

  $score = 0
  if ($HasGateway) { $score += 100 }
  if ($Header -match 'Wireless LAN adapter|WLAN|Wi-Fi|WiFi') { $score += 40 }
  if ($Header -match 'Ethernet adapter') { $score += 30 }
  if ($Address -match '^192\.168\.') { $score += 20 }
  elseif ($Address -match '^10\.') { $score += 15 }
  elseif ($Address -match '^172\.(1[6-9]|2[0-9]|3[0-1])\.') { $score += 10 }
  return $score
}

$raw = ipconfig
$blocks = @()
$current = $null

foreach ($line in $raw) {
  if ($line -match '^\S.*adapter .*:\s*$') {
    if ($current) { $blocks += $current }
    $current = [ordered]@{
      Header = $line.Trim()
      IPv4 = ''
      Gateway = ''
      Disconnected = $false
    }
    continue
  }

  if (-not $current) { continue }
  if ($line -match 'Media disconnected') { $current.Disconnected = $true }
  if ($line -match 'IPv4.*?:\s*([0-9.]+)') { $current.IPv4 = $Matches[1] }
  if ($line -match 'Default Gateway.*?:\s*([0-9.]+)') { $current.Gateway = $Matches[1] }
}

if ($current) { $blocks += $current }

$candidates = foreach ($block in $blocks) {
  $header = [string] $block.Header
  $ip = [string] $block.IPv4
  if ($block.Disconnected) { continue }
  if (-not (Test-PrivateIPv4 $ip)) { continue }
  if ($header -match 'Unknown adapter|vEthernet|WSL|Docker|Hyper-V|VMware|VirtualBox|Loopback|Bluetooth') { continue }

  [pscustomobject]@{
    IP = $ip
    Score = Get-AdapterScore $header $ip ([bool] $block.Gateway)
  }
}

$selected = $candidates | Sort-Object Score -Descending | Select-Object -First 1
if ($selected) {
  Write-Output $selected.IP
  exit 0
}

$fallbacks = foreach ($block in $blocks) {
  $ip = [string] $block.IPv4
  if ($block.Disconnected) { continue }
  if (Test-PrivateIPv4 $ip) { $ip }
}

$fallback = $fallbacks | Select-Object -First 1

if ($fallback) {
  Write-Output $fallback
} else {
  Write-Output '127.0.0.1'
}
