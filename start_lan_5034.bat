@echo off
cd /d "%~dp0"
set PORT=5034
set REALTIME_BASE_URLS=http://192.168.127.10:9002
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$ip = Get-NetIPConfiguration | Where-Object { $_.IPv4Address -and $_.IPv4DefaultGateway } | Select-Object -First 1 -ExpandProperty IPv4Address; if (-not $ip) { $ip = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' } | Select-Object -First 1 }; if ($ip) { $ip.IPAddress } else { '127.0.0.1' }"`) do set LAN_IP=%%i
echo Workbench URL: http://%LAN_IP%:%PORT%/
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://%LAN_IP%:%PORT%/'"
npm start
