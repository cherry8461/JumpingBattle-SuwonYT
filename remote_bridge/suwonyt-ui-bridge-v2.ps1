# Suwon Yeongtong internal MQTT bridge.
# Map dropdowns and game start/stop controls are never used.

Add-Type -AssemblyName UIAutomationClient

$configPath = Join-Path $PSScriptRoot 'bridge-config.json'
$logPath = Join-Path $PSScriptRoot 'suwonyt-ui-bridge.log'
$config = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$agentId = [string]$config.agent_id
$serverUrl = ([string]$config.server_url).TrimEnd('/')
$token = [string]$config.agent_token
$armed = [bool]$config.custom_ui_bridge_armed
$allowedRooms = @($config.custom_ui_bridge_allowed_rooms | ForEach-Object { ([string]$_).Trim().ToUpperInvariant() })
$pollMilliseconds = [Math]::Max(500, [int](([double]$config.poll_seconds) * 1000))
$mqttHost = [string]$config.manager_mqtt_host
$mqttPort = [int]$config.manager_mqtt_port
$mqttUsername = [string]$config.manager_mqtt_username
$mqttPassword = [string]$config.manager_mqtt_password
$mqttPublish = 'D:\JPLuncher\apps\250625_v2_0_3_JumPing_Manager\assest\mosquitto\mosquitto_pub.exe'

# Confirmed by the live manager's JP/score_rank map table.
$mapSerials = @{
    'small:basic' = 236; 'small:easy' = 233; 'small:normal' = 234; 'small:hard' = 237; 'small:challenger' = 254
    'medium:basic' = 231; 'medium:easy' = 215; 'medium:normal' = 209; 'medium:hard' = 214; 'medium:challenger' = 253
    'large:basic' = 221; 'large:easy' = 213; 'large:normal' = 210; 'large:hard' = 212; 'large:challenger' = 256
}

function Write-BridgeLog([string]$message) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message"
    Add-Content -Path $logPath -Value $line -Encoding UTF8
    Write-Host $line
}

function New-Label([int[]]$codes) {
    return (-join ($codes | ForEach-Object { [char]$_ }))
}

function Get-Descendants($element) {
    return $element.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
}

function Get-ChildByIdSuffix($element, [string]$suffix) {
    foreach ($candidate in (Get-Descendants $element)) {
        if ($candidate.Current.AutomationId.EndsWith($suffix, [System.StringComparison]::OrdinalIgnoreCase)) { return $candidate }
    }
    return $null
}

function Get-ElementText($element) {
    if (-not $element) { return '' }
    try { return [string]$element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value }
    catch { return [string]$element.Current.Name }
}

function Get-ManagerRoot {
    $process = Get-Process -Name '1_main' -ErrorAction Stop | Sort-Object StartTime | Select-Object -First 1
    if ($process.MainWindowHandle -eq 0) { throw 'Manager window was not found.' }
    return [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
}

function Get-GamePanels($root) {
    $panels = @()
    foreach ($candidate in (Get-Descendants $root)) {
        if ($candidate.Current.ClassName -ne 'Game_modnule') { continue }
        $title = Get-ChildByIdSuffix $candidate 'ui_label_title'
        $roomId = if ($title) { ([string]$title.Current.Name).Trim().ToUpperInvariant() } else { '' }
        if ($roomId -in @('C1','C2','B1','B2')) { $panels += [pscustomobject]@{ RoomId=$roomId; Element=$candidate } }
    }
    return @($panels | Sort-Object { [array]::IndexOf(@('C1','C2','B1','B2'), $_.RoomId) })
}

function Get-PanelId([string]$roomId) { return @{ C1=0; C2=1; B1=2; B2=3 }[$roomId] }

# The dashboard command API uses the manager's numeric room IDs for
# compatibility with the original bridge.  Resolve them to the labels shown
# in this manager before touching any UI or publishing MQTT.
function Resolve-RoomId([string]$roomId) {
    $value = ([string]$roomId).Trim().ToUpperInvariant()
    $numericRooms = @{ '0'='C1'; '1'='C2'; '2'='B1'; '3'='B2' }
    if ($numericRooms.ContainsKey($value)) { return $numericRooms[$value] }
    return $value
}

function Get-PeopleIndex($panel) {
    $people = Get-ChildByIdSuffix $panel.Element 'ui_combo_people'
    $text = (Get-ElementText $people).Trim()
    if ($text -match '^(\d+)') { return [int]$Matches[1] }
    return 0
}

function Normalize-MapSize([string]$prefix) {
    $value = (([string]$prefix) -replace '\s', '').ToLowerInvariant()
    if ($value -eq 'small' -or $value -eq (New-Label @(49548,54805))) { return 'small' }
    if ($value -eq 'medium' -or $value -eq (New-Label @(51473,54805))) { return 'medium' }
    if ($value -eq 'large' -or $value -eq (New-Label @(45824,54805))) { return 'large' }
    throw "Unsupported room size: $prefix"
}

function Normalize-LevelKey([string]$level) {
    $key = (([string]$level) -replace '\s', '').ToLowerInvariant()
    $aliases = @{}
    $aliases['basic'] = 'basic'; $aliases[(New-Label @(48288,51060,51649))] = 'basic'
    $aliases['easy'] = 'easy'; $aliases[(New-Label @(51060,51648))] = 'easy'
    $aliases['normal'] = 'normal'; $aliases[(New-Label @(45432,47680))] = 'normal'
    $aliases['hard'] = 'hard'; $aliases[(New-Label @(54616,46300))] = 'hard'
    $aliases['challenger'] = 'challenger'; $aliases[(New-Label @(52300,47536,51200))] = 'challenger'
    if (-not $aliases.ContainsKey($key)) { throw "Internal MQTT map is not registered: $level" }
    return $aliases[$key]
}

function Get-MapSerial([string]$prefix, [string]$level) {
    $key = "$(Normalize-MapSize $prefix):$(Normalize-LevelKey $level)"
    if (-not $mapSerials.ContainsKey($key)) { throw "Map serial is not registered: $key" }
    return [int]$mapSerials[$key]
}

function Invoke-InfoReceiver($panel) {
    # This opens only the manager's short-lived MQTT input window.
    $button = Get-ChildByIdSuffix $panel.Element 'ui_button_infoadd'
    if (-not $button) { throw 'Manager information receiver was not found.' }
    $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}

function Publish-ManagerInfo([int]$panelId, [int]$mapSerial, [string]$teamName, [int]$peopleIndex) {
    if (-not (Test-Path -LiteralPath $mqttPublish)) { throw 'Manager MQTT publisher was not found.' }
    $payload = @{ cmd='infook'; id=$panelId; map_serial=$mapSerial; teamname=$teamName; num_people=$peopleIndex } | ConvertTo-Json -Compress
    & $mqttPublish -h $mqttHost -p $mqttPort -u $mqttUsername -P $mqttPassword -t 'JP/app' -m $payload -q 0
    if ($LASTEXITCODE -ne 0) { throw "Manager MQTT publish failed (exit $LASTEXITCODE)." }
}

function Test-ManagerConfirmation([object]$panel, [string]$teamName, [string]$mapPrefix, [string]$levelKey) {
    $actualTeam = (Get-ElementText (Get-ChildByIdSuffix $panel.Element 'ui_edit_teamname')).Trim()
    $actualMap = (Get-ElementText (Get-ChildByIdSuffix $panel.Element 'ui_combo_map')).Trim()
    $parts = $actualMap -split '-', 2
    if ($parts.Count -ne 2) { return $false }
    try {
        return ($actualTeam -eq $teamName) -and
            ((Normalize-MapSize $parts[0]) -eq (Normalize-MapSize $mapPrefix)) -and
            ((Normalize-LevelKey $parts[1]) -eq (Normalize-LevelKey $levelKey))
    } catch { return $false }
}

function Get-PanelSummary([object]$panel) {
    $team = (Get-ElementText (Get-ChildByIdSuffix $panel.Element 'ui_edit_teamname')).Trim()
    $map = (Get-ElementText (Get-ChildByIdSuffix $panel.Element 'ui_combo_map')).Trim()
    return "team='$team', map='$map'"
}

function Wait-ManagerConfirmation([object]$panel, [string]$teamName, [string]$mapPrefix, [string]$levelKey) {
    # The manager applies its internal MQTT message asynchronously after the
    # receiver is armed.  Confirm both the team and chosen map before success.
    $deadline = (Get-Date).AddSeconds(3)
    do {
        if (Test-ManagerConfirmation $panel $teamName $mapPrefix $levelKey) { return $true }
        Start-Sleep -Milliseconds 100
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Acknowledge($commandId, [string]$status, $result) {
    $body = @{ commandId=$commandId; status=$status; agentId=$agentId; result=$result } | ConvertTo-Json -Depth 8 -Compress
    Invoke-RestMethod -Method Post -Uri "$serverUrl/api/agent/ack" -Headers @{ 'x-jumping-agent-token'=$token } -ContentType 'application/json; charset=utf-8' -Body $body | Out-Null
}

function Get-RoomState($panel) {
    $mapCombo = Get-ChildByIdSuffix $panel.Element 'ui_combo_map'
    $teamInput = Get-ChildByIdSuffix $panel.Element 'ui_edit_teamname'
    return [ordered]@{ roomId=$panel.RoomId; status=''; teamName=(Get-ElementText $teamInput); mapName=(Get-ElementText $mapCombo); mapIndex=0; mapOptions=@(); uiBridge=$true; level=''; people=(Get-PeopleIndex $panel); remainingSeconds=0 }
}

function Execute-Command($command, $panelMap) {
    $commandId = [string]$command.id
    try {
        if (-not $armed) { throw 'Local bridge is locked.' }
        if ([string]$command.action -ne 'set_info') { throw 'Unsupported action.' }
        $roomId = Resolve-RoomId ([string]$command.roomId)
        $panel = $panelMap[$roomId]
        if (-not $panel) { throw "Unknown room: $roomId" }
        if ($panel.RoomId -notin $allowedRooms) { throw "Room not enabled: $roomId" }
        $payload = $command.payload
        $panelId = Get-PanelId $roomId
        $mapSerial = Get-MapSerial ([string]$payload.mapPrefix) ([string]$payload.levelKey)
        $peopleIndex = Get-PeopleIndex $panel
        $teamName = ([string]$payload.teamName).Trim()
        if ([string]::IsNullOrWhiteSpace($teamName)) { throw 'Team name is required.' }
        Write-BridgeLog "received $commandId room=$roomId mapSerial=$mapSerial"
        # This is the manager's internal MQTT receive window.  No game start,
        # stop, QR, or visible map-dropdown control is used by this bridge.
        Invoke-InfoReceiver $panel
        # The manager first opens its MQTT subscription after processing the
        # receiver action.  Wait for that local setup instead of racing it.
        Start-Sleep -Milliseconds 650
        Write-BridgeLog "receiver armed room=$roomId; sending internal MQTT"
        # The receive window is armed before the one-and-only MQTT message is sent.
        Publish-ManagerInfo $panelId $mapSerial $teamName $peopleIndex
        if (-not (Wait-ManagerConfirmation $panel $teamName ([string]$payload.mapPrefix) ([string]$payload.levelKey))) {
            throw "Manager did not confirm the team name and map within 3 seconds ($(Get-PanelSummary $panel))."
        }
        Acknowledge $commandId 'completed' @{ room=$roomId; teamName=$teamName; level=$payload.level; mapSerial=$mapSerial; people=$peopleIndex }
        Write-BridgeLog "completed $commandId room=$roomId"
    } catch {
        $message = $_.Exception.Message
        try { Acknowledge $commandId 'failed' @{ error=$message } } catch { }
        Write-BridgeLog "failed ${commandId}: $message"
    }
}

Write-BridgeLog "SuwonYT internal MQTT bridge started (armed=$armed, rooms=$($allowedRooms -join ','))."
while ($true) {
    try {
        $root = Get-ManagerRoot
        $panels = Get-GamePanels $root
        if ($panels.Count -ne 4) { throw "Expected four rooms but found $($panels.Count)." }
        $panelMap = @{}; $rooms = @()
        foreach ($panel in $panels) { $panelMap[$panel.RoomId] = $panel; $rooms += Get-RoomState $panel }
        $body = @{ agentId=$agentId; version='suwonyt-internal-mqtt-1'; armed=$armed; simulate=$false; managerVisible=$true; rooms=$rooms } | ConvertTo-Json -Depth 8 -Compress
        $reply = Invoke-RestMethod -Method Post -Uri "$serverUrl/api/agent/sync" -Headers @{ 'x-jumping-agent-token'=$token } -ContentType 'application/json; charset=utf-8' -Body $body
        foreach ($command in @($reply.commands)) { Execute-Command $command $panelMap }
    } catch { Write-BridgeLog "sync failed: $($_.Exception.Message)" }
    Start-Sleep -Milliseconds $pollMilliseconds
}
