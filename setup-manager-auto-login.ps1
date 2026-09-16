$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Manager Auto Login Setup'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$configDir = Join-Path $projectRoot 'config'
$credentialPath = Join-Path $configDir 'manager-login.clixml'

New-Item -ItemType Directory -Path $configDir -Force | Out-Null

Write-Host 'Saving manager credentials in an encrypted file for this Windows user only.' -ForegroundColor Cyan
Write-Host 'The password is not stored in source code or Git.' -ForegroundColor Cyan

$credential = Get-Credential -Message 'Enter your Jumping Manager ID and password.' -UserName ''
if ([string]::IsNullOrWhiteSpace($credential.UserName)) {
    throw 'No user ID was entered.'
}

[pscustomobject]@{
    Username = $credential.UserName
    Password = ConvertFrom-SecureString -SecureString $credential.Password
    SavedAt = (Get-Date).ToString('s')
} | Export-Clixml -LiteralPath $credentialPath -Force

Write-Host ''
Write-Host 'Auto-login settings have been saved.' -ForegroundColor Green
Write-Host 'This encrypted file can only be used by this Windows user on this PC.' -ForegroundColor Green
Read-Host 'Press Enter to close this window'
