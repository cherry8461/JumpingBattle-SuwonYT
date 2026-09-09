$ErrorActionPreference = 'Stop'

# One-click operation launcher.
# 1) Start the manager, 2) wait until login creates a fresh manager log,
# 3) start the dashboard server, 4) start the direct UI bridge.

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$managerDir = 'D:\JPLuncher\apps\250625_v2_0_3_JumPing_Manager'
$managerExe = Join-Path $managerDir '1_main_suwonyt_mqtt_receivefix_test.exe'
$managerLogDir = Join-Path $managerDir 'file\log'
$dashboardBat = Join-Path $projectRoot 'run_game_monitor.bat'
$bridgeBat = Join-Path $projectRoot 'remote_bridge\run-suwonyt-ui-bridge.cmd'
$startedAt = Get-Date

function Test-PortOpen([int]$Port) {
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Test-BridgeRunning {
    return [bool](Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -match 'suwonyt-direct-ui-bridge\.ps1'
    })
}

if (-not (Test-Path -LiteralPath $managerExe)) { throw "Manager executable was not found: $managerExe" }
if (-not (Test-Path -LiteralPath $managerLogDir)) { throw "Manager log directory was not found: $managerLogDir" }
if (-not (Test-Path -LiteralPath $dashboardBat)) { throw "Dashboard launcher was not found: $dashboardBat" }
if (-not (Test-Path -LiteralPath $bridgeBat)) { throw "Bridge launcher was not found: $bridgeBat" }

$manager = Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -eq '1_main_suwonyt_mqtt_receivefix_test'
} | Select-Object -First 1

if (-not $manager) {
    Write-Host 'Starting Jumping Manager. Please log in.' -ForegroundColor Cyan
    Start-Process -FilePath $managerExe -WorkingDirectory $managerDir
} else {
    Write-Host 'Jumping Manager is already open. Waiting for its login log.' -ForegroundColor Yellow
}

Write-Host 'Waiting for a new manager log after login...' -ForegroundColor Cyan
$deadline = (Get-Date).AddMinutes(15)
do {
    $freshLog = Get-ChildItem -LiteralPath $managerLogDir -Filter '*.txt' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -ge $startedAt.AddSeconds(-2) } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($freshLog) { break }
    Start-Sleep -Seconds 2
} while ((Get-Date) -lt $deadline)

if (-not $freshLog) {
    throw 'No new manager log was found within 15 minutes. Log in to the manager, then run this launcher again.'
}

Write-Host "Manager login log detected: $($freshLog.Name)" -ForegroundColor Green

if (-not (Test-PortOpen 8081)) {
    Write-Host 'Starting dashboard server...' -ForegroundColor Cyan
    Start-Process -FilePath $dashboardBat -WorkingDirectory $projectRoot
    $serverDeadline = (Get-Date).AddSeconds(30)
    while (-not (Test-PortOpen 8081)) {
        if ((Get-Date) -ge $serverDeadline) { throw 'Dashboard server did not start on port 8081.' }
        Start-Sleep -Seconds 1
    }
} else {
    Write-Host 'Dashboard server is already running on port 8081.' -ForegroundColor Yellow
}

if (-not (Test-BridgeRunning)) {
    Write-Host 'Starting direct UI bridge...' -ForegroundColor Cyan
    Start-Process -FilePath $bridgeBat -WorkingDirectory (Split-Path $bridgeBat)
} else {
    Write-Host 'Direct UI bridge is already running.' -ForegroundColor Yellow
}

Write-Host 'Operation startup is complete.' -ForegroundColor Green
Write-Host 'Keep the Manager, dashboard, bridge, and Chrome Naver calendar open.' -ForegroundColor Green
Read-Host 'Press Enter to close this launcher window'
