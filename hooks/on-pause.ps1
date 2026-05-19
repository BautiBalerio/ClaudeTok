$ErrorActionPreference = "SilentlyContinue"
$node = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.15.0-win-x64\node.exe"
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { exit 0 }
$cli = Join-Path (Split-Path $PSScriptRoot -Parent) "src\cli.mjs"
if (-not (Test-Path $cli)) { exit 0 }
Start-Process -FilePath $node -ArgumentList "`"$cli`"", "pause" -WindowStyle Hidden
