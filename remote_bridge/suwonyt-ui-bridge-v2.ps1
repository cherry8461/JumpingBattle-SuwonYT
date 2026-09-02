# Stable local UI bridge. Uses keyboard selection for manager map combos.
# No start, stop, or information-request buttons are used.

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms

$configPath = Join-Path $PSScriptRoot 'bridge-config.json'
$logPath = Join-Path $PSScriptRoot 'suwonyt-ui-bridge.log'
$config = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$agentId = [string]$config.agent_id
$serverUrl = ([string]$config.server_url).TrimEnd('/')
$token = [string]$config.agent_token
$armed = [bool]$config.custom_ui_bridge_armed
$allowedRooms = @($config.custom_ui_bridge_allowed_rooms | ForEach-Object { ([string]$_).Trim().ToUpperInvariant() })
$pollMilliseconds = [Math]::Max(500, [int](([double]$config.poll_seconds) * 1000))

function Write-BridgeLog([string]$message) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message"
    Add-Content -Path $logPath -Value $line -Encoding UTF8
    Write-Host $line
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
        if ($roomId -in @('C1','C2','B1','B2')) {
            $panels += [pscustomobject]@{ RoomId=$roomId; Element=$candidate }
        }
    }
    return @($panels | Sort-Object { [array]::IndexOf(@('C1','C2','B1','B2'), $_.RoomId) })
}

function Get-ElementText($element) {
    if (-not $element) { return '' }
    try { return [string]$element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value }
    catch { return [string]$element.Current.Name }
}

function Set-ElementValue($element, [string]$value) {
    $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($value)
}

function Get-PrefixSignature([string]$value) {
    if ([string]::IsNullOrWhiteSpace($value)) { return '' }
    $prefix = ($value -split '-', 2)[0]
    return (($prefix.ToCharArray() | ForEach-Object { [int][char]$_ }) -join ',')
}

function Get-MapIndex([string]$prefix, [string]$token) {
    $level = ([string]$token).Trim().ToLowerInvariant()
    $levelIndexes = @{ basic=0; easy=1; normal=2; hard=3; challenger=4; space=5; summer=6; kids=7; santa=8 }
    if (-not $levelIndexes.ContainsKey($level)) { return -1 }
    $baseIndex = [int]$levelIndexes[$level]
    $signature = Get-PrefixSignature $prefix
    # C small=49548,54805; B large=45824,54805; B medium=51473,54805.
    if ($signature -eq '49548,54805') { return $baseIndex }
    if ($signature -eq '45824,54805') { return $baseIndex }
    if ($signature -eq '51473,54805') { return 10 + $baseIndex }
    return -1
}

function Select-Map($combo, [string]$prefix, [string]$token) {
    $index = Get-MapIndex $prefix $token
    if ($index -lt 0) { throw "Unsupported map request: $prefix-$token" }
    $expand = $combo.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    $combo.SetFocus()
    $expand.Expand()
    Start-Sleep -Milliseconds 100
    [System.Windows.Forms.SendKeys]::SendWait('{HOME}')
    for ($i = 0; $i -lt $index; $i++) { [System.Windows.Forms.SendKeys]::SendWait('{DOWN}') }
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Start-Sleep -Milliseconds 180
    $selected = Get-ElementText $combo
    $selectedPrefix = Get-PrefixSignature $selected
    $requestedPrefix = Get-PrefixSignature $prefix
    $selectedToken = (($selected -split '-', 2)[-1] -replace '\s', '').ToLowerInvariant()
    if ($selectedPrefix -ne $requestedPrefix -or $selectedToken -ne $token.ToLowerInvariant()) {
        throw "Map selection not confirmed. Current: $selected"
    }
    Write-BridgeLog "map selected: $prefix-$token (index=$index)"
}

function Get-RoomState($panel) {
    $mapCombo = Get-ChildByIdSuffix $panel.Element 'ui_combo_map'
    $teamInput = Get-ChildByIdSuffix $panel.Element 'ui_edit_teamname'
    return [ordered]@{ roomId=$panel.RoomId; status=''; teamName=(Get-ElementText $teamInput); mapName=(Get-ElementText $mapCombo); mapIndex=0; mapOptions=@(); uiBridge=$true; level=''; people=''; remainingSeconds=0 }
}

function Acknowledge($commandId, [string]$status, $result) {
    $body = @{ commandId=$commandId; status=$status; agentId=$agentId; result=$result } | ConvertTo-Json -Depth 8 -Compress
    Invoke-RestMethod -Method Post -Uri "$serverUrl/api/agent/ack" -Headers @{ 'x-jumping-agent-token'=$token } -ContentType 'application/json; charset=utf-8' -Body $body | Out-Null
}

function Execute-Command($command, $panelMap) {
    $commandId = [string]$command.id
    try {
        if (-not $armed) { throw 'Local UI bridge is locked.' }
        if ([string]$command.action -ne 'set_info') { throw 'Unsupported action.' }
        $roomId = ([string]$command.roomId).Trim().ToUpperInvariant()
        $panel = $panelMap[$roomId]
        if (-not $panel) { throw "Unknown room: $roomId" }
        if ($panel.RoomId -notin $allowedRooms) { throw "Room not enabled: $roomId" }
        $teamInput = Get-ChildByIdSuffix $panel.Element 'ui_edit_teamname'
        $mapCombo = Get-ChildByIdSuffix $panel.Element 'ui_combo_map'
        if (-not $teamInput -or -not $mapCombo) { throw 'Required controls were not found.' }
        $payload = $command.payload
        Write-BridgeLog "received $commandId room=$roomId"
        Set-ElementValue $teamInput ([string]$payload.teamName)
        Select-Map $mapCombo ([string]$payload.mapPrefix) ([string]$payload.levelKey)
        Acknowledge $commandId 'completed' @{ room=$roomId; teamName=$payload.teamName; level=$payload.level }
        Write-BridgeLog "completed $commandId room=$roomId"
    } catch {
        $message = $_.Exception.Message
        try { Acknowledge $commandId 'failed' @{ error=$message } } catch { }
        Write-BridgeLog "failed ${commandId}: $message"
    }
}

Write-BridgeLog "SuwonYT UI bridge v2 started (armed=$armed, rooms=$($allowedRooms -join ','))."
while ($true) {
    try {
        $root = Get-ManagerRoot
        $panels = Get-GamePanels $root
        if ($panels.Count -ne 4) { throw "Expected four rooms but found $($panels.Count)." }
        $panelMap = @{}
        $rooms = @()
        foreach ($panel in $panels) { $panelMap[$panel.RoomId] = $panel; $rooms += Get-RoomState $panel }
        $body = @{ agentId=$agentId; version='suwonyt-ui-bridge-2'; armed=$armed; simulate=$false; managerVisible=$true; rooms=$rooms } | ConvertTo-Json -Depth 8 -Compress
        $reply = Invoke-RestMethod -Method Post -Uri "$serverUrl/api/agent/sync" -Headers @{ 'x-jumping-agent-token'=$token } -ContentType 'application/json; charset=utf-8' -Body $body
        foreach ($command in @($reply.commands)) { Execute-Command $command $panelMap }
    } catch { Write-BridgeLog "sync failed: $($_.Exception.Message)" }
    Start-Sleep -Milliseconds $pollMilliseconds
}
