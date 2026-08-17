# DSH Browser Control - install helper
# Checks repo file integrity and prints installation steps. Does NOT modify any config.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\install.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Write-Host "=== DSH Browser Control install check ===" -ForegroundColor Cyan

# 1. extension files
$extFiles = @(
  'extension\manifest.json',
  'extension\background.js',
  'extension\content.js',
  'extension\popup.html',
  'extension\popup.js',
  'extension\icons\icon16.png',
  'extension\icons\icon48.png',
  'extension\icons\icon128.png'
)
$missing = @()
foreach ($f in $extFiles) {
  if (-not (Test-Path (Join-Path $root $f))) { $missing += $f }
}
if ($missing.Count -gt 0) {
  Write-Host "[FAIL] missing extension files: $($missing -join ', ')" -ForegroundColor Red
} else {
  Write-Host "[ OK ] extension files complete" -ForegroundColor Green
  try {
    $null = Get-Content (Join-Path $root 'extension\manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Host "[ OK ] manifest.json valid" -ForegroundColor Green
  } catch {
    Write-Host "[FAIL] manifest.json invalid: $($_.Exception.Message)" -ForegroundColor Red
  }
}

# 2. plugin files
$pluginFiles = @('plugin\plugin.js', 'plugin\client.js')
$missingP = @()
foreach ($f in $pluginFiles) {
  if (-not (Test-Path (Join-Path $root $f))) { $missingP += $f }
}
if ($missingP.Count -gt 0) {
  Write-Host "[FAIL] missing plugin files: $($missingP -join ', ')" -ForegroundColor Red
} else {
  Write-Host "[ OK ] plugin files complete" -ForegroundColor Green
}

# 3. node (optional, only for plugin\test scripts)
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { Write-Host "[ OK ] node found ($($node.Source))" -ForegroundColor Green }
else { Write-Host "[WARN] node not found (only needed by plugin\test scripts, not for installing)" -ForegroundColor Yellow }

Write-Host ""
Write-Host "=== Installation steps ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Step 1: Install the browser extension"
Write-Host "  1) Open chrome://extensions (Edge: edge://extensions)"
Write-Host "  2) Enable 'Developer mode'"
Write-Host "  3) Click 'Load unpacked' and select: $root\extension"
Write-Host ""
Write-Host "Step 2: Install the DSH plugin - paste this whole paragraph into a DSH session:"
Write-Host ""
Write-Host "  Please install the browser-control plugin: read $root\plugin\plugin.js as the Host"
Write-Host "  code, read $root\plugin\client.js as the Client code, create and run it with"
Write-Host "  cordis_define, then call browser_pairing_code and tell me the pairing code."
Write-Host ""
Write-Host "  (After it runs, approve the run card in the conversation with the double-checkmark)"
Write-Host ""
Write-Host "Step 3: Pair"
Write-Host "  1) Copy the pairing code the agent gives you"
Write-Host "  2) Click the extension icon in the toolbar, paste the token, click Connect"
Write-Host "  3) Done when the popup shows 'Connected'"
Write-Host ""
Write-Host "See README.md for details." -ForegroundColor DarkGray
