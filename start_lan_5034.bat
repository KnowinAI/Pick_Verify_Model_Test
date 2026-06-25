@echo off
setlocal
cd /d "%~dp0"
set PORT=5034
set REALTIME_BASE_URLS=http://192.168.127.10:9002
for /f "usebackq delims=" %%i in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\get_lan_ip.ps1"`) do set LAN_IP=%%i
if "%LAN_IP%"=="" set LAN_IP=127.0.0.1
set HOST=0.0.0.0
set APP_BASE_URL=http://%LAN_IP%:%PORT%
echo Local URL:     http://127.0.0.1:%PORT%/
echo Coworker URL:  %APP_BASE_URL%/
echo.
echo If coworkers cannot open it, allow inbound TCP %PORT% in Windows Firewall.
echo Checking if port %PORT% is already in use...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$deadline = (Get-Date).AddSeconds(6); do { $c = @(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue); if ($c.Count -eq 0) { break }; foreach ($conn in $c) { Write-Host ('Port %PORT% busy, stopping old process ' + $conn.OwningProcess); Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $deadline); $c = @(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue); if ($c.Count -eq 0) { Write-Host 'Port %PORT% is free' } else { Write-Host 'WARNING: port %PORT% still busy' }"
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process '%APP_BASE_URL%/'"
call npm.cmd start
