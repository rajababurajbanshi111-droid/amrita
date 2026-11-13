# Smart WebRTC Classroom - Dedicated LAN Edition Launcher
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  Starting Smart WebRTC Classroom (LAN-Only Edition)" -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Cyan
Set-Location -Path $PSScriptRoot
if (-not (Test-Path "$PSScriptRoot\node_modules\ws")) {
    Write-Host "[INFO] First time run detected. Installing ws dependency..." -ForegroundColor Yellow
    npm.cmd install
}
node server.js
