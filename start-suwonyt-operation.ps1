$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'New Operation Start'

# One-click operation launcher.
# 1) Start the manager, 2) wait until login creates a fresh manager log,
# 3) start the dashboard server, 4) start the direct UI bridge.

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$managerDir = 'D:\JPLuncher\apps\250625_v2_0_3_JumPing_Manager'
$managerExe = Join-Path $managerDir '1_main_suwonyt_mqtt_receivefix_timer960_safe.exe'
$managerProcessNames = @(
    '1_main_suwonyt_mqtt_receivefix_timerfix',
    '1_main_suwonyt_mqtt_receivefix_timer960_safe',
    '1_main_suwonyt_mqtt_receivefix_test'
)
$managerLogDir = Join-Path $managerDir 'file\log'
$managerOtherDir = Join-Path $managerDir 'file\other'
$dashboardLauncher = Join-Path $projectRoot 'run_game_monitor.bat'
$bridgeBat = Join-Path $projectRoot 'remote_bridge\run-suwonyt-ui-bridge.cmd'
$autoLoginScript = Join-Path $projectRoot 'manager-auto-login.ps1'
$autoLoginRunner = Join-Path $projectRoot 'manager-auto-login-runner.ps1'
$autoLoginCredential = Join-Path $projectRoot 'config\manager-login.clixml'
$startedAt = Get-Date

function Test-PortOpen([int]$Port) {
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Test-BridgeRunning {
    return [bool](Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -match 'suwonyt-direct-ui-bridge\.ps1'
    })
}

function Get-ManagerUiProcess {
    return Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessName -in $managerProcessNames -and $_.MainWindowHandle -ne 0
    } | Sort-Object StartTime -Descending | Select-Object -First 1
}

if (-not (Test-Path -LiteralPath $managerExe)) { throw "Manager executable was not found: $managerExe" }
if (-not (Test-Path -LiteralPath $managerLogDir)) { throw "Manager log directory was not found: $managerLogDir" }
if (-not (Test-Path -LiteralPath $managerOtherDir)) {
    New-Item -ItemType Directory -Path $managerOtherDir -Force | Out-Null
}
if (-not (Test-Path -LiteralPath $dashboardLauncher)) { throw "Dashboard launcher was not found: $dashboardLauncher" }
if (-not (Test-Path -LiteralPath $bridgeBat)) { throw "Bridge launcher was not found: $bridgeBat" }
if (-not (Test-Path -LiteralPath $autoLoginScript)) { throw "Manager auto login helper was not found: $autoLoginScript" }
if (-not (Test-Path -LiteralPath $autoLoginRunner)) { throw "Manager auto login runner was not found: $autoLoginRunner" }

$manager = Get-ManagerUiProcess

if (-not $manager) {
    Write-Host 'Starting Jumping Manager.' -ForegroundColor Cyan
    Start-Process -FilePath $managerExe -WorkingDirectory $managerDir
    $managerWindowDeadline = (Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 500
        $manager = Get-ManagerUiProcess
    } while (-not $manager -and (Get-Date) -lt $managerWindowDeadline)
} else {
    Write-Host 'Jumping Manager is already open. Waiting for its login log.' -ForegroundColor Yellow
}

if ($manager) {
    # UI Automation can occasionally wait inside a third-party window call.
    # Run it separately so this launcher can keep watching for the login log.
    Write-Host 'Starting manager auto-login helper...' -ForegroundColor Cyan
    Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $autoLoginRunner,
        '-ManagerProcessId', [string]$manager.Id,
        '-CredentialPath', $autoLoginCredential
    )
} else {
    Write-Host 'Manager window was not detected. Open or log in to the Manager manually.' -ForegroundColor Yellow
}

Write-Host 'Waiting for a new manager log after login...' -ForegroundColor Cyan
$freshLog = $null
# A dashboard-only retry can happen immediately after a successful login.
# Reuse only a very recent manager log so a not-yet-logged-in manager still waits.
if ($manager) {
    $freshLog = Get-ChildItem -LiteralPath $managerLogDir -Filter '*.txt' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -ge $startedAt.AddMinutes(-5) } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($freshLog) {
        Write-Host "Reusing recent manager login log: $($freshLog.Name)" -ForegroundColor Yellow
    }
}
$deadline = (Get-Date).AddMinutes(15)
if (-not $freshLog) {
    do {
        $freshLog = Get-ChildItem -LiteralPath $managerLogDir -Filter '*.txt' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -ge $startedAt.AddSeconds(-2) } |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if ($freshLog) { break }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
}

if (-not $freshLog) {
    throw 'No new manager log was found within 15 minutes. Log in to the manager, then run this launcher again.'
}

Write-Host "Manager login log detected: $($freshLog.Name)" -ForegroundColor Green

if (-not (Test-PortOpen 8080)) {
    Write-Host 'Starting dashboard server...' -ForegroundColor Cyan
    Start-Process -FilePath $dashboardLauncher -WorkingDirectory $projectRoot
    $serverDeadline = (Get-Date).AddSeconds(30)
    while (-not (Test-PortOpen 8080)) {
        if ((Get-Date) -ge $serverDeadline) { throw 'Dashboard server did not start on port 8080.' }
        Start-Sleep -Seconds 1
    }
} else {
    Write-Host 'Dashboard server is already running on port 8080.' -ForegroundColor Yellow
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
