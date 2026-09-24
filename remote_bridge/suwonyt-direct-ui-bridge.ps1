Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
$Host.UI.RawUI.WindowTitle = 'SuwonYT Bridge'
if (-not ('SuwonYT.NativeWindow' -as [type])) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
namespace SuwonYT {
  public static class NativeWindow {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  }
}
'@
}

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = Get-Content -Raw (Join-Path $rootDir 'bridge-config.json') | ConvertFrom-Json
$serverUrl = ([string]$config.server_url).TrimEnd('/')
$token = [string]$config.agent_token
$agentId = [string]$config.agent_id
$armed = [bool]$config.armed
$pollMs = [Math]::Max(500, [int]([double]$config.poll_seconds * 1000))
$logPath = Join-Path $rootDir 'suwonyt-direct-ui-bridge.log'
$mqttHost = [string]$config.manager_mqtt_host
$mqttPort = [int]$config.manager_mqtt_port
$mqttUsername = [string]$config.manager_mqtt_username
$mqttPassword = [string]$config.manager_mqtt_password
$mqttPublish = 'D:\JPLuncher\apps\250625_v2_0_3_JumPing_Manager\assest\mosquitto\mosquitto_pub.exe'
$script:lastStateSignature = @{}

# Actual map serials from the SuwonYT ranking data / manager installation.
# These are manager map IDs, not dropdown positions.
$mapSerials = @{
  'small:basic'=236; 'small:easy'=233; 'small:normal'=234; 'small:hard'=237; 'small:challenger'=254
  'small:space'=255; 'small:summer'=262; 'small:kids'=267; 'small:santa'=270
  'medium:basic'=231; 'medium:easy'=215; 'medium:normal'=209; 'medium:hard'=214; 'medium:challenger'=253
  'medium:space'=252; 'medium:summer'=261; 'medium:kids'=266; 'medium:santa'=269
  'large:basic'=221; 'large:easy'=213; 'large:normal'=210; 'large:hard'=212; 'large:challenger'=256
  'large:space'=217; 'large:summer'=250; 'large:kids'=222; 'large:santa'=265
}

function Log([string]$text) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $text"
  Add-Content -LiteralPath $logPath -Value $line -Encoding utf8
  Write-Host $line
}
$script:lastSyncError = ''
$script:lastSyncErrorLoggedAt = [datetime]::MinValue
$script:suppressedSyncErrors = 0
$syncErrorSummarySeconds = 300

function LogSyncIssue([string]$message) {
  $now = Get-Date
  $changed = $script:lastSyncError -ne $message
  $summaryDue = ($now - $script:lastSyncErrorLoggedAt).TotalSeconds -ge $syncErrorSummarySeconds
  if ($changed -or $summaryDue) {
    $suffix = if (-not $changed -and $script:suppressedSyncErrors -gt 0) {
      " (same error suppressed $($script:suppressedSyncErrors) times)"
    } else { '' }
    Log "$message$suffix"
    $script:lastSyncError = $message
    $script:lastSyncErrorLoggedAt = $now
    $script:suppressedSyncErrors = 0
  } else {
    $script:suppressedSyncErrors++
  }
}

function ClearSyncIssue {
  if ($script:lastSyncError) {
    $suffix = if ($script:suppressedSyncErrors -gt 0) {
      "; suppressed repeats=$($script:suppressedSyncErrors)"
    } else { '' }
    Log "Bridge connection recovered$suffix."
  }
  $script:lastSyncError = ''
  $script:lastSyncErrorLoggedAt = [datetime]::MinValue
  $script:suppressedSyncErrors = 0
}
function Descendants($element) {
  # Qt rebuilds parts of its UI tree while a game changes state.  A raw UIA
  # traversal can then fail halfway through.  Restart the whole snapshot a few
  # times instead of leaving the bridge disconnected until the next command.
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      $items = New-Object System.Collections.Generic.List[System.Windows.Automation.AutomationElement]
      $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
      $stack = New-Object System.Collections.Generic.Stack[System.Windows.Automation.AutomationElement]
      $rootChildren = New-Object System.Collections.Generic.List[System.Windows.Automation.AutomationElement]
      $rootChild = $walker.GetFirstChild($element)
      while ($rootChild) {
        [void]$rootChildren.Add($rootChild)
        $rootChild = $walker.GetNextSibling($rootChild)
      }
      for ($index = $rootChildren.Count - 1; $index -ge 0; $index--) {
        $stack.Push($rootChildren[$index])
      }
      while ($stack.Count -gt 0) {
        $node = $stack.Pop()
        [void]$items.Add($node)
        $children = New-Object System.Collections.Generic.List[System.Windows.Automation.AutomationElement]
        $child = $walker.GetFirstChild($node)
        while ($child) {
          [void]$children.Add($child)
          $child = $walker.GetNextSibling($child)
        }
        for ($index = $children.Count - 1; $index -ge 0; $index--) {
          $stack.Push($children[$index])
        }
      }
      return $items
    } catch {
      if ($attempt -eq 3) { throw }
      Start-Sleep -Milliseconds (80 * $attempt)
    }
  }
}
function BySuffix($element, [string]$suffix) {
  foreach ($item in (Descendants $element)) { if ($item.Current.AutomationId.EndsWith($suffix)) { return $item } }
  return $null
}
function Text($element) {
  if (-not $element) { return '' }
  $candidates = New-Object System.Collections.Generic.List[string]
  try { [void]$candidates.Add([string]$element.Current.Name) } catch {}
  try {
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    [void]$candidates.Add([string]$pattern.Current.Value)
  } catch {}

  # Some Qt controls expose a damaged ValuePattern string while Current.Name
  # still contains the Korean text shown on screen (or vice versa). Prefer the
  # non-empty candidate with the fewest replacement/question-mark characters.
  $best = ''
  $bestScore = [int]::MaxValue
  foreach ($candidate in $candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
    $damage = ([regex]::Matches($candidate, ([char]0xFFFD))).Count * 100
    $damage += ([regex]::Matches($candidate, '\?')).Count * 10
    $damage += ([regex]::Matches($candidate, '[\u00C0-\u00FF]{2,}')).Count * 20
    if ($damage -lt $bestScore) { $best = $candidate; $bestScore = $damage }
  }
  return $best
}
function Panels() {
  # 운영본(1_main.exe)과 원본을 보존한 수원영통 테스트본을 모두 인식한다.
  $proc = Get-Process -ErrorAction Stop | Where-Object {
    $_.ProcessName -eq '1_main' -or $_.ProcessName -like '1_main_suwonyt_mqtt_*'
  } | Select-Object -First 1
  if (-not $proc) { throw '점핑매니저 프로세스를 찾을 수 없습니다.' }
  # Before login completes the process exists but does not yet expose a window.
  # Return an empty set once; the main loop will log a single waiting message.
  if ($proc.MainWindowHandle -eq [IntPtr]::Zero) { return @{} }
  $window = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
  $script:managerWindow = $window
  $found = @{}
  foreach ($item in (Descendants $window)) {
    if ($item.Current.ClassName -ne 'Game_modnule') { continue }
    $title = (Text (BySuffix $item 'ui_label_title')).Trim().ToUpper()
    if ($title -in @('C1','C2','B1','B2')) { $found[$title] = $item }
  }
  return $found
}
function State($room, $panel) {
  $state = @{ roomId=$room; status=(Text (BySuffix $panel 'ui_label_game_status')); teamName=(Text (BySuffix $panel 'ui_edit_teamname')); mapName=(Text (BySuffix $panel 'ui_combo_map')); mapIndex=0; mapOptions=@(); uiBridge=$true; level=(Text (BySuffix $panel 'ui_label_level')); people=0; remainingSeconds=0 }
  $signature = "$($state.status)|$($state.teamName)|$($state.mapName)|$($state.level)"
  if ($script:lastStateSignature[$room] -ne $signature) {
    $script:lastStateSignature[$room] = $signature
    Log "manager state room=$room status='$($state.status)' team='$($state.teamName)' map='$($state.mapName)' level='$($state.level)'"
  }
  return $state
}
function AgentRoom([string]$room) { return @{ '0'='C1'; '1'='C2'; '2'='B1'; '3'='B2' }[$room] }
function ManagerRoomId([string]$room) { return @{ 'C1'=0; 'C2'=1; 'B1'=2; 'B2'=3 }[$room] }
function Get-MapSerial([string]$size, [string]$level) {
  $key = "$(([string]$size).Trim().ToLowerInvariant()):$(([string]$level).Trim().ToLowerInvariant())"
  if (-not $mapSerials.ContainsKey($key)) { throw "Map serial is not registered: $key" }
  return [int]$mapSerials[$key]
}
function Send-MapMqtt([int]$managerRoomId, [int]$mapSerial, [string]$teamName, [int]$people) {
  if (-not (Test-Path -LiteralPath $mqttPublish)) { throw 'Manager MQTT publisher was not found.' }
  # mosquitto_pub receives its command line through the Windows ANSI boundary.
  # Keep the MQTT body ASCII-only so Korean team names remain valid UTF-8 JSON
  # when the manager decodes the payload.
  $payload = @{ cmd='infook'; id=$managerRoomId; map_serial=$mapSerial; teamname=$teamName; num_people=$people } | ConvertTo-Json -Compress
  $payload = [regex]::Replace($payload, '[^\x00-\x7F]', { param($match) ('\u{0:X4}' -f [int][char]$match.Value) })
  Log "mqtt publish requested topic=JP/app roomId=$managerRoomId mapSerial=$mapSerial people=$people payload=$payload"
  $processInfo = New-Object System.Diagnostics.ProcessStartInfo
  $processInfo.FileName = $mqttPublish
  $escapedPayload = $payload.Replace('"', '\"')
  $processInfo.Arguments = "-h $mqttHost -p $mqttPort -u $mqttUsername -P $mqttPassword -t JP/app -m `"$escapedPayload`" -q 0"
  $processInfo.UseShellExecute = $false
  $processInfo.RedirectStandardOutput = $true
  $processInfo.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::Start($processInfo)
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  Log "mqtt publish completed exit=$($process.ExitCode) stdout=$stdout stderr=$stderr"
  if ($process.ExitCode -ne 0) { throw "Manager MQTT publish failed (exit $($process.ExitCode))." }
}
function Select-MediumMap($panel, [string]$level) {
  $combo = BySuffix $panel 'ui_combo_map'
  if (-not $combo) { throw 'Medium map dropdown was not found.' }

  # B rooms show 10 large maps first and the 9 medium maps afterwards. Qt does
  # not expose the popup list consistently, so select its known position by
  # keyboard within the combo itself.
  $mediumOffsets = @{ basic=10; easy=11; normal=12; hard=13; challenger=14; space=15; summer=16; kids=17; santa=18 }
  $key = $level.Trim().ToLowerInvariant()
  if (-not $mediumOffsets.ContainsKey($key)) { throw "Unsupported medium map level: $level" }
  $expected = $mediumOffsets[$key]
  $mediumPrefix = ('{0}{1}' -f [char]0xC911, [char]0xD615)

  # SendKeys goes to the active top-level window. SetFocus alone does not
  # foreground the manager while this bridge console is active.
  [void][SuwonYT.NativeWindow]::SetForegroundWindow([IntPtr]$script:managerWindow.Current.NativeWindowHandle)
  Start-Sleep -Milliseconds 150
  $combo.SetFocus()
  Start-Sleep -Milliseconds 100
  [System.Windows.Forms.SendKeys]::SendWait('{F4}')
  Start-Sleep -Milliseconds 100
  [System.Windows.Forms.SendKeys]::SendWait('{HOME}')
  Start-Sleep -Milliseconds 80
  for ($i = 0; $i -lt $expected; $i++) {
    [System.Windows.Forms.SendKeys]::SendWait('{DOWN}')
    Start-Sleep -Milliseconds 35
  }
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Milliseconds 300
  $selected = (Text $combo).Trim()
  if (-not $selected.Replace(' ','').StartsWith($mediumPrefix)) {
    throw "Medium map dropdown selection was not confirmed (expected index $expected, got '$selected')."
  }
  return $selected
}
function SetInfo($command, $panelMap) {
  $room = AgentRoom ([string]$command.roomId)
  if (-not $room -or -not $panelMap.ContainsKey($room)) { throw "Unknown room $($command.roomId)" }
  $payload=$command.payload; $panel=$panelMap[$room]
  $team=BySuffix $panel 'ui_edit_teamname'; $combo=BySuffix $panel 'ui_combo_map'
  if (-not $team) { throw 'Team name control was not found.' }
  Log "stage 1/6 command accepted id=$($command.id) room=$room"
  $team.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue(([string]$payload.teamName).Substring(0,[Math]::Min(10,([string]$payload.teamName).Length)))
  Log "stage 2/6 team name applied directly room=$room"
  # Do not invoke the information-request button or touch the map dropdown.
  # The manager receives the selected map through its local MQTT API by serial.
  Log "command received room=$room requestedSize=$($payload.mapPrefix) requestedLevel=$($payload.levelKey) requestedTeam=$($payload.teamName)"
  $mapSerial=Get-MapSerial ([string]$payload.mapPrefix) ([string]$payload.levelKey)
  Log "stage 3/6 map serial resolved room=$room mapSerial=$mapSerial"
  $people=0
  $peopleControl=BySuffix $panel 'ui_combo_people'
  if ($peopleControl -and (Text $peopleControl) -match '^(\d+)') { $people=[int]$Matches[1] }
  Send-MapMqtt (ManagerRoomId $room) $mapSerial ([string]$payload.teamName) $people
  Log "stage 4/6 MQTT broker accepted publish room=$room managerRoomId=$(ManagerRoomId $room)"
  Log "mqtt map sent room=$room managerRoomId=$(ManagerRoomId $room) serial=$mapSerial level=$($payload.levelKey)"
  return @{ room=$room; teamName=$payload.teamName; mapSerial=$mapSerial }
}
function StartGame($command, $panelMap) {
  $room = AgentRoom ([string]$command.roomId)
  if (-not $room -or -not $panelMap.ContainsKey($room)) { throw "Unknown room $($command.roomId)" }
  $panel = $panelMap[$room]
  $status = (Text (BySuffix $panel 'ui_label_game_status')).Trim()
  if ($status -match '게임중|playing|running') { throw "$room game is already running." }
  $playButton = BySuffix $panel 'ui_button_play'
  if (-not $playButton) { throw "Game start button was not found for $room." }
  if (-not $playButton.Current.IsEnabled) { throw "$room game start button is disabled." }
  Log "game start requested room=$room"
  $playButton.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  Log "game start button invoked room=$room"
  return @{ room=$room; action='start_game' }
}
function Confirm-ManagerStopDialog {
  # The manager displays a separate confirmation dialog after its stop button
  # is pressed. Find that dialog by process id and invoke its affirmative
  # button; no coordinates or keyboard shortcuts are used.
  $managerPid = $script:managerWindow.Current.ProcessId
  $deadline = (Get-Date).AddSeconds(3)
  $yesNames = @(([string][char]0xC608), 'Yes', '&Yes', (([string][char]0xD655) + ([string][char]0xC778)), 'OK')
  do {
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
      [System.Windows.Automation.TreeScope]::Children,
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $managerPid
      ))
    )
    foreach ($window in $windows) {
      foreach ($item in (Descendants $window)) {
        if ($item.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button) { continue }
        $name = ([string]$item.Current.Name).Trim()
        if ($yesNames -contains $name) {
          try {
            $item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
            Log "manager stop confirmation accepted button=$name"
            return $true
          } catch {}
        }
      }
    }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $deadline)
  throw 'Manager stop confirmation dialog was not found.'
}
function StopGame($command, $panelMap) {
  $room = AgentRoom ([string]$command.roomId)
  if (-not $room -or -not $panelMap.ContainsKey($room)) { throw "Unknown room $($command.roomId)" }
  $panel = $panelMap[$room]
  $stopButton = BySuffix $panel 'ui_button_stop'
  if (-not $stopButton) { throw "Game stop button was not found for $room." }
  if (-not $stopButton.Current.IsEnabled) { throw "$room game stop button is disabled." }
  Log "game stop requested room=$room"
  $stopButton.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  Log "game stop button invoked room=$room; waiting for confirmation dialog"
  [void](Confirm-ManagerStopDialog)
  return @{ room=$room; action='stop_game' }
}
function Post($path,$body) {
  # Windows PowerShell 5 may corrupt Korean text at its HTTP string boundary.
  # Escape every non-ASCII character as JSON \uXXXX first, then send an
  # ASCII-only payload. The Flask JSON parser restores the original Unicode.
  $json = $body | ConvertTo-Json -Depth 8 -Compress
  $safeJson = [regex]::Replace($json, '[^\x00-\x7F]', {
    param($match)
    ('\u{0:X4}' -f [int][char]$match.Value)
  })
  $asciiBody = [System.Text.Encoding]::ASCII.GetBytes($safeJson)
  Invoke-RestMethod -Method Post -Uri "$serverUrl$path" -Headers @{'x-jumping-agent-token'=$token} -ContentType 'application/json; charset=utf-8' -Body $asciiBody
}
Log "SuwonYT direct UI bridge started (armed=$armed)."
while($true) {
 try {
  $panels=Panels
  if($panels.Count -ne 4){
    $message = "Waiting for manager login: expected C1,C2,B1,B2 but found $($panels.Count)."
    LogSyncIssue $message
    Start-Sleep -Milliseconds $pollMs
    continue
  }
  ClearSyncIssue
  $reply=Post '/api/agent/sync' @{agentId=$agentId;version='suwonyt-direct-ui-1';armed=$armed;simulate=$false;managerVisible=$true;rooms=@('C1','C2','B1','B2'|ForEach-Object{State $_ $panels[$_]})}
  foreach($command in @($reply.commands)) { try { if(-not $armed){throw 'Bridge is locked.'}; if($command.action -eq 'set_info'){ $result=SetInfo $command $panels } elseif($command.action -eq 'start_game'){ $result=StartGame $command $panels } elseif($command.action -eq 'stop_game'){ $result=StopGame $command $panels } else { throw 'Unsupported action.' }; Post '/api/agent/ack' @{commandId=$command.id;status='completed';agentId=$agentId;result=$result}|Out-Null; Log "completed $($command.id)" } catch { Post '/api/agent/ack' @{commandId=$command.id;status='failed';agentId=$agentId;result=@{error=$_.Exception.Message}}|Out-Null; Log "failed $($command.id): $($_.Exception.Message)" } }
 } catch { LogSyncIssue "sync failed: $($_.Exception.Message)" }
 Start-Sleep -Milliseconds $pollMs
}
