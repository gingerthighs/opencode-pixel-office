# opencode-pixel-office installer for Windows (PowerShell 5.1 or 7).
#   .\install.ps1                         build + install globally (%USERPROFILE%\.config\opencode\plugins)
#   .\install.ps1 --host 0.0.0.0 --token auto
#   .\install.ps1 --project C:\code\app   install for one project only
#   .\install.ps1 --uninstall
# Blocked by the execution policy? Run:  powershell -ExecutionPolicy Bypass -File .\install.ps1
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "✖ Node.js >= 22.18 wird benötigt (nur zum Bauen): https://nodejs.org" -ForegroundColor Red
  Write-Host "  oder: winget install OpenJS.NodeJS.LTS"
  exit 1
}

$version = (& node -p "process.versions.node").Trim()
$parts = $version.Split(".")
$major = [int]$parts[0]
$minor = [int]$parts[1]
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 18)) {
  Write-Host "✖ Node $version ist zu alt – benötigt wird >= 22.18 (führt TypeScript direkt aus)." -ForegroundColor Red
  exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host "✖ npm fehlt (kommt normalerweise mit Node.js)." -ForegroundColor Red
  exit 1
}

& node scripts/install.ts @args
exit $LASTEXITCODE
