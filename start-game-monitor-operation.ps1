$ErrorActionPreference = 'Stop'

# 운영본 자동 시작:
# 1) 점핑매니저 실행, 2) 로그인 후 새 점핑매니저 로그 감지,
# 3) 기존 운영 대시보드/랭킹 시스템 실행
$managerDir = 'D:\JPLuncher\apps\250625_v2_0_3_JumPing_Manager'
$managerExe = Join-Path $managerDir '1_main.exe'
$managerLogDir = Join-Path $managerDir 'file\log'
$monitorDir = 'D:\game_monitor'
$monitorBat = Join-Path $monitorDir 'run_game_monitor.bat'
$startedAt = Get-Date

function Test-PortOpen([int]$Port) {
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Get-ManagerProcess {
    $names = @(
        '1_main',
        '1_main_suwonyt_mqtt_receivefix_test',
        '1_main_suwonyt_mqtt_broom_test'
    )
    return Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $names -contains $_.ProcessName
    } | Select-Object -First 1
}

if (-not (Test-Path -LiteralPath $managerExe)) { throw "점핑매니저 실행 파일을 찾지 못했습니다: $managerExe" }
if (-not (Test-Path -LiteralPath $managerLogDir)) { throw "점핑매니저 로그 폴더를 찾지 못했습니다: $managerLogDir" }
if (-not (Test-Path -LiteralPath $monitorBat)) { throw "운영 대시보드 실행 파일을 찾지 못했습니다: $monitorBat" }

$manager = Get-ManagerProcess
if (-not $manager) {
    Write-Host '점핑매니저를 실행합니다. 로그인해 주세요.' -ForegroundColor Cyan
    Start-Process -FilePath $managerExe -WorkingDirectory $managerDir
} else {
    Write-Host '점핑매니저가 이미 열려 있습니다. 로그인 후 새 로그를 기다립니다.' -ForegroundColor Yellow
}

Write-Host '점핑매니저 로그인 후 생성되는 새 로그를 기다리는 중입니다...' -ForegroundColor Cyan
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
    throw '15분 안에 새 점핑매니저 로그를 찾지 못했습니다. 점핑매니저 로그인 후 이 파일을 다시 실행해 주세요.'
}

Write-Host "로그인 로그 감지 완료: $($freshLog.Name)" -ForegroundColor Green

if (-not (Test-PortOpen 8080)) {
    Write-Host '운영 대시보드와 랭킹 시스템을 실행합니다...' -ForegroundColor Cyan
    Start-Process -FilePath $monitorBat -WorkingDirectory $monitorDir
} else {
    Write-Host '운영 대시보드가 이미 실행 중입니다.' -ForegroundColor Yellow
}

Write-Host '운영 시작 준비가 완료되었습니다.' -ForegroundColor Green
Read-Host '이 창을 닫으려면 Enter를 누르세요'
