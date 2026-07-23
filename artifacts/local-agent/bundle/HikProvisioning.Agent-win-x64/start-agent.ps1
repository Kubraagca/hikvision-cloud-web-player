Set-Location -LiteralPath $PSScriptRoot
Start-Process -FilePath (Join-Path $PSScriptRoot 'HikProvisioning.Agent.exe')
