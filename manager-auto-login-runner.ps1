param(
    [Parameter(Mandatory = $true)][int]$ManagerProcessId,
    [Parameter(Mandatory = $true)][string]$CredentialPath
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$helper = Join-Path $projectRoot 'manager-auto-login.ps1'

. $helper
[void](Invoke-ManagerAutoLogin -ProcessId $ManagerProcessId -CredentialPath $CredentialPath)
