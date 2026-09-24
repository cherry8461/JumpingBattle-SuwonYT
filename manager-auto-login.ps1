function ConvertTo-SendKeysLiteral([string]$Text) {
    $escaped = New-Object System.Text.StringBuilder
    foreach ($character in $Text.ToCharArray()) {
        switch ($character) {
            '+' { [void]$escaped.Append('{+}') }
            '^' { [void]$escaped.Append('{^}') }
            '%' { [void]$escaped.Append('{%}') }
            '~' { [void]$escaped.Append('{~}') }
            '(' { [void]$escaped.Append('{(}') }
            ')' { [void]$escaped.Append('{)}') }
            '{' { [void]$escaped.Append('{{}') }
            '}' { [void]$escaped.Append('{}}') }
            '[' { [void]$escaped.Append('{[}') }
            ']' { [void]$escaped.Append('{]}') }
            default { [void]$escaped.Append($character) }
        }
    }
    return $escaped.ToString()
}

function Get-ManagerLoginEditControls([int]$ProcessId) {
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $process -or $process.MainWindowHandle -eq 0) { return @() }

    try {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
        $condition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Edit
        )
        return @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition))
    } catch {
        return @()
    }
}

function Invoke-ManagerLoginButton([int]$ProcessId) {
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $process -or $process.MainWindowHandle -eq 0) { return $false }

    try {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
        $condition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Button
        )
        $buttons = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition))
        # Verified manager login control: QApplication.MainWindow.centralwidget.widget.ButtonLogin
        $loginButton = $buttons | Where-Object {
            $_.Current.AutomationId -eq 'QApplication.MainWindow.centralwidget.widget.ButtonLogin'
        } | Select-Object -First 1

        if (-not $loginButton) { return $false }

        $invoke = $loginButton.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern) -as [System.Windows.Automation.InvokePattern]
        if ($invoke) {
            Write-Host 'Invoking the verified manager login button.' -ForegroundColor Cyan
            $invoke.Invoke()
            return $true
        }

        $loginButton.SetFocus()
        [System.Windows.Forms.SendKeys]::SendWait(' ')
        return $true
    } catch {
        Write-Host "Unable to invoke manager login button: $($_.Exception.Message)" -ForegroundColor Yellow
        return $false
    }
}

function Test-ManagerLoginButton([int]$ProcessId) {
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $process -or $process.MainWindowHandle -eq 0) { return $false }

    try {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
        $condition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
            'QApplication.MainWindow.centralwidget.widget.ButtonLogin'
        )
        return $null -ne $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    } catch {
        return $false
    }
}

function Invoke-ManagerAutoLogin {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$CredentialPath
    )

    if (-not (Test-Path -LiteralPath $CredentialPath)) {
        Write-Host 'Auto-login settings were not found. Waiting for manual login.' -ForegroundColor Yellow
        return $false
    }

    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
        $saved = Import-Clixml -LiteralPath $CredentialPath
        $username = [string]$saved.Username
        $password = [System.Net.NetworkCredential]::new('', (ConvertTo-SecureString -String ([string]$saved.Password))).Password
        if ([string]::IsNullOrWhiteSpace($username) -or [string]::IsNullOrWhiteSpace($password)) {
            throw 'Saved auto-login settings are empty.'
        }
    } catch {
        Write-Host "Unable to read auto-login settings: $($_.Exception.Message)" -ForegroundColor Yellow
        return $false
    }

    $shell = New-Object -ComObject WScript.Shell
    $deadline = (Get-Date).AddSeconds(45)
    do {
        $edits = @(Get-ManagerLoginEditControls -ProcessId $ProcessId)
        # Never type into the post-login dashboard. Some dashboard states also
        # expose exactly two edit controls, so require the verified login button.
        if ($edits.Count -eq 2 -and (Test-ManagerLoginButton -ProcessId $ProcessId) -and $shell.AppActivate($ProcessId)) {
            try {
                $edits[0].SetFocus()
                Start-Sleep -Milliseconds 150
                [System.Windows.Forms.SendKeys]::SendWait('^a')
                [System.Windows.Forms.SendKeys]::SendWait((ConvertTo-SendKeysLiteral $username))
                $edits[1].SetFocus()
                Start-Sleep -Milliseconds 150
                [System.Windows.Forms.SendKeys]::SendWait('^a')
                [System.Windows.Forms.SendKeys]::SendWait((ConvertTo-SendKeysLiteral $password))
                Start-Sleep -Milliseconds 200
                if (Invoke-ManagerLoginButton -ProcessId $ProcessId) {
                    Write-Host 'Manager credentials were entered and the login button was invoked.' -ForegroundColor Green
                    return $true
                }
                Write-Host 'Verified login button could not be invoked. Waiting for manual login.' -ForegroundColor Yellow
                return $false
            } catch {
                Write-Host "Unable to complete automatic credential entry: $($_.Exception.Message)" -ForegroundColor Yellow
                return $false
            }
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)

    Write-Host 'Manager login controls were not found. Waiting for manual login.' -ForegroundColor Yellow
    return $false
}
