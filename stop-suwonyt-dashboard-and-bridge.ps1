$ErrorActionPreference = 'Stop'

# 신규본만 안전하게 종료합니다.
# - 8080 포트의 대시보드 서버
# - 수원영통 MQTT 브릿지
# 점핑매니저는 종료하지 않습니다.

$serverConnections = Get-NetTCPConnection -State Listen -LocalPort 8080 -ErrorAction SilentlyContinue
$serverPids = @($serverConnections | Select-Object -ExpandProperty OwningProcess -Unique)

foreach ($processId in $serverPids) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($process) {
        Write-Host "신규본 대시보드 종료: $($process.ProcessName) (PID $processId)" -ForegroundColor Yellow
        Stop-Process -Id $processId -Force
    }
}

$bridgeProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -match 'suwonyt-direct-ui-bridge\.ps1'
}
foreach ($bridge in $bridgeProcesses) {
    Write-Host "신규본 브릿지 종료: $($bridge.Name) (PID $($bridge.ProcessId))" -ForegroundColor Yellow
    Stop-Process -Id $bridge.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 800
if (Get-NetTCPConnection -State Listen -LocalPort 8080 -ErrorAction SilentlyContinue) {
    throw '8080 포트가 아직 열려 있습니다.'
}

Write-Host '신규본 대시보드와 브릿지 종료 완료. 점핑매니저는 계속 실행 중입니다.' -ForegroundColor Green
Read-Host '이 창을 닫으려면 Enter를 누르세요'
