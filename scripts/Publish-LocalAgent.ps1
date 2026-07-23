param(
    [string]$Configuration = "Release",
    [string]$Runtime = "win-x64",
    [switch]$SkipBuild = $true
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$srcRoot = Join-Path $root "src\HikDiscovery"
$artifactsRoot = Join-Path $root "artifacts\local-agent"
$agentBuildDir = Join-Path $srcRoot "HikProvisioning.Agent\bin\x64\$Configuration\net9.0-windows"
$cliBuildDir = Join-Path $srcRoot "HikSdk.ProvisioningCli\bin\x64\$Configuration\net9.0-windows"
$bundleDir = Join-Path $artifactsRoot "bundle\HikProvisioning.Agent-$Runtime"
$bundleToolsDir = Join-Path $bundleDir "tools\HikSdk.ProvisioningCli"
$downloadDir = Join-Path $srcRoot "HikProvisioning.Web\wwwroot\downloads\local-agent"
$zipPath = Join-Path $downloadDir "HikProvisioning.Agent-$Runtime.zip"

Write-Host "Temizlik yapiliyor..."
Remove-Item -LiteralPath $artifactsRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $downloadDir -Recurse -Force -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Path $bundleDir -Force | Out-Null
New-Item -ItemType Directory -Path $bundleToolsDir -Force | Out-Null
New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null

$agentProject = Join-Path $srcRoot "HikProvisioning.Agent\HikProvisioning.Agent.csproj"
$cliProject = Join-Path $srcRoot "HikSdk.ProvisioningCli\HikSdk.ProvisioningCli.csproj"

if (-not $SkipBuild)
{
    Write-Host "CLI build aliniyor..."
    dotnet build $cliProject -c $Configuration --no-restore -p:Platform=x64 -p:RestoreIgnoreFailedSources=true -p:NuGetAudit=false
    if ($LASTEXITCODE -ne 0) { throw "CLI build basarisiz." }

    Write-Host "Agent build aliniyor..."
    dotnet build $agentProject -c $Configuration --no-restore -p:Platform=x64 -p:RestoreIgnoreFailedSources=true -p:NuGetAudit=false
    if ($LASTEXITCODE -ne 0) { throw "Agent build basarisiz." }
}
else
{
    Write-Host "Mevcut build ciktisi kullaniliyor..."
}

if (!(Test-Path $cliBuildDir)) { throw "CLI build klasoru bulunamadi: $cliBuildDir" }
if (!(Test-Path $agentBuildDir)) { throw "Agent build klasoru bulunamadi: $agentBuildDir" }

Write-Host "Bundle hazirlaniyor..."
Copy-Item -Path (Join-Path $agentBuildDir "*") -Destination $bundleDir -Recurse -Force
Copy-Item -Path (Join-Path $cliBuildDir "*") -Destination $bundleToolsDir -Recurse -Force

$cmdPath = Join-Path $bundleDir "start-agent.cmd"
$cmdContent = @"
@echo off
cd /d %~dp0
start "" "%~dp0HikProvisioning.Agent.exe"
"@
Set-Content -LiteralPath $cmdPath -Value $cmdContent -Encoding ASCII

$ps1Path = Join-Path $bundleDir "start-agent.ps1"
$ps1Content = @"
Set-Location -LiteralPath `$PSScriptRoot
Start-Process -FilePath (Join-Path `$PSScriptRoot 'HikProvisioning.Agent.exe')
"@
Set-Content -LiteralPath $ps1Path -Value $ps1Content -Encoding ASCII

$installPs1Path = Join-Path $bundleDir "install-agent.ps1"
$installPs1Content = @"
param(
    [switch]`$AddToStartup = `$true
)

`$ErrorActionPreference = 'Stop'

`$sourceDir = `$PSScriptRoot
`$targetDir = Join-Path `$env:LOCALAPPDATA 'HikProvisioningAgent'
`$startupDir = [Environment]::GetFolderPath('Startup')
`$desktopDir = [Environment]::GetFolderPath('Desktop')
`$shell = New-Object -ComObject WScript.Shell

if (Test-Path `$targetDir) {
    Remove-Item -LiteralPath `$targetDir -Recurse -Force
}

New-Item -ItemType Directory -Path `$targetDir -Force | Out-Null
Copy-Item -Path (Join-Path `$sourceDir '*') -Destination `$targetDir -Recurse -Force

`$startCmdPath = Join-Path `$targetDir 'start-agent.cmd'
`$desktopShortcut = Join-Path `$desktopDir 'Hikvision Kamera Yardimcisi.lnk'
`$desktopLink = `$shell.CreateShortcut(`$desktopShortcut)
`$desktopLink.TargetPath = `$startCmdPath
`$desktopLink.WorkingDirectory = `$targetDir
`$desktopLink.Save()

if (`$AddToStartup) {
    `$startupShortcut = Join-Path `$startupDir 'Hikvision Kamera Yardimcisi.lnk'
    `$startupLink = `$shell.CreateShortcut(`$startupShortcut)
    `$startupLink.TargetPath = `$startCmdPath
    `$startupLink.WorkingDirectory = `$targetDir
    `$startupLink.Save()
}

Start-Process -FilePath `$startCmdPath
Write-Host "Kurulum tamamlandi: `$targetDir"
"@
Set-Content -LiteralPath $installPs1Path -Value $installPs1Content -Encoding ASCII

$installCmdPath = Join-Path $bundleDir "install-agent.cmd"
$installCmdContent = @"
@echo off
cd /d %~dp0
powershell -ExecutionPolicy Bypass -File "%~dp0install-agent.ps1"
pause
"@
Set-Content -LiteralPath $installCmdPath -Value $installCmdContent -Encoding ASCII

$readmePath = Join-Path $bundleDir "README.txt"
$readmeContent = @"
HikProvisioning.Agent

1. install-agent.cmd dosyasina bir kez cift tiklayin.
2. Kurulum dosyalari su klasore kopyalanir:
   %LOCALAPPDATA%\HikProvisioningAgent
3. Masaustune kisayol birakilir ve agent baslatilir.
4. Agent localhost uzerinde su adreste dinler:
   http://127.0.0.1:47831
5. Ardindan web panelde /LocalAgent sayfasini acin.

Notlar:
- Bu paket HikSdk.ProvisioningCli ve gerekli HCNetSDK dosyalarini icerir.
- Kamera ile ayni yerel agdaki Windows bilgisayarda calismalidir.
- Parola, token, AK/SK ve verification code degerlerini loglamayin.
"@
Set-Content -LiteralPath $readmePath -Value $readmeContent -Encoding ASCII

Write-Host "ZIP uretiliyor..."
if (Test-Path $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
}
tar.exe -a -c -f $zipPath -C $bundleDir .
if ($LASTEXITCODE -ne 0) { throw "ZIP olusturma basarisiz." }

Write-Host "Tamamlandi:"
Write-Host "Bundle: $bundleDir"
Write-Host "Zip:    $zipPath"
