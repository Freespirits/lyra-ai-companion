# Lyra — one-command installer for Windows.
# Run in PowerShell:
#   irm https://raw.githubusercontent.com/Freespirits/lyra-ai-companion/main/install.ps1 | iex
# or download this file and right-click -> Run with PowerShell.
#
# It ensures Node, downloads the app, installs it (which also fetches the avatar
# bodies), then hands off to the cross-platform setup wizard for the AI/voice/
# hearing choices and a double-click launcher. The un-scriptable prerequisites
# (Node, Ollama, subscription CLIs) are opened for you with clear instructions.

$ErrorActionPreference = 'Stop'
function Have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }

Write-Host ""
Write-Host "  Lyra" -ForegroundColor Cyan -NoNewline; Write-Host " — a talking, 3D avatar companion, on your machine."
Write-Host ""

# 1) Node.js 20+
$needNode = $true
if (Have node) {
  try { $maj = [int](((node -v) -replace '^v(\d+)\..*', '$1')); if ($maj -ge 20) { $needNode = $false } } catch {}
}
if ($needNode) {
  Write-Host "  Node.js 20+ is required." -ForegroundColor Yellow
  Write-Host "  I'll open the download page — install the LTS version (Next / Next / Finish),"
  Write-Host "  then run this installer again."
  Start-Process "https://nodejs.org/en/download/prebuilt-installer"
  Read-Host "  Press Enter to close"
  return
}
Write-Host ("  Node " + (node -v) + " OK") -ForegroundColor Green

# 2) Download / update the app
$dir = Join-Path $HOME "Lyra"
$repo = "https://github.com/Freespirits/lyra-ai-companion"
if (Test-Path (Join-Path $dir ".git")) {
  Write-Host "  Updating your existing install at $dir ..."
  Push-Location $dir; try { git pull --ff-only } catch {}; Pop-Location
} elseif (Test-Path $dir) {
  Write-Host "  Using existing folder $dir"
} else {
  Write-Host "  Downloading Lyra to $dir ..."
  if (Have git) {
    git clone --depth 1 "$repo.git" $dir
  } else {
    $zip = Join-Path $env:TEMP "lyra.zip"
    Invoke-WebRequest "$repo/archive/refs/heads/main.zip" -OutFile $zip
    Expand-Archive $zip -DestinationPath $env:TEMP -Force
    Move-Item (Join-Path $env:TEMP "lyra-ai-companion-main") $dir
    Remove-Item $zip -Force
  }
}
Set-Location $dir

# 3) Install (postinstall also downloads the avatar bodies + seeds .env)
Write-Host ""
Write-Host "  Installing — this also downloads her bodies (~75 MB), about a minute..."
npm install

# 4) Interactive setup: AI brain, voice, hearing, build, launcher
node scripts/setup-wizard.mjs

# 5) Offer to start her now
Write-Host ""
$go = Read-Host "  Start Lyra now? [Y/n]"
if ($go -eq '' -or $go -match '^[Yy]') {
  Start-Process (Join-Path $dir "Lyra.bat")
}
