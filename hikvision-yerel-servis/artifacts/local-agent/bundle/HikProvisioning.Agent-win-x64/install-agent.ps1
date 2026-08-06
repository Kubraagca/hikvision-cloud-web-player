param(
    [switch]$AddToStartup = $true
)

$ErrorActionPreference = 'Stop'

$sourceDir = $PSScriptRoot
$targetDir = Join-Path $env:LOCALAPPDATA 'HikProvisioningAgent'
$startupDir = [Environment]::GetFolderPath('Startup')
$desktopDir = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell

if (Test-Path $targetDir) {
    Remove-Item -LiteralPath $targetDir -Recurse -Force
}

New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
Copy-Item -Path (Join-Path $sourceDir '*') -Destination $targetDir -Recurse -Force

$startCmdPath = Join-Path $targetDir 'start-agent.cmd'
$desktopShortcut = Join-Path $desktopDir 'Hikvision Kamera Yardimcisi.lnk'
$desktopLink = $shell.CreateShortcut($desktopShortcut)
$desktopLink.TargetPath = $startCmdPath
$desktopLink.WorkingDirectory = $targetDir
$desktopLink.Save()

if ($AddToStartup) {
    $startupShortcut = Join-Path $startupDir 'Hikvision Kamera Yardimcisi.lnk'
    $startupLink = $shell.CreateShortcut($startupShortcut)
    $startupLink.TargetPath = $startCmdPath
    $startupLink.WorkingDirectory = $targetDir
    $startupLink.Save()
}

Start-Process -FilePath $startCmdPath
Write-Host "Kurulum tamamlandi: $targetDir"
