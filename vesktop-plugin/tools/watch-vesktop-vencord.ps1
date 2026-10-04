<#
.SYNOPSIS
    Keeps Vesktop's Vencord files in sync with the locally built Vencord
    (the one containing the MacroDeckBridge userplugin).

.DESCRIPTION
    Vesktop loads Vencord from:  State.store.vencordDir || <sessionData>\vencordFiles

    Vesktop's menu item "Force Update Vencord" (and `vesktop --repair`) calls its
    internal downloadVencordFiles(), which OVERWRITES vencordDesktop*.js/css in
    that directory with the official Vencord release — silently removing custom
    builds like this plugin.

    This script compares the deployed files against `Vencord\dist` and restores
    them when they differ, then writes the required BOM-less `package.json`
    ("{}"). Run it manually after any Vesktop/Vencord update, or register it as
    a scheduled task so it self-heals automatically:

        powershell -ExecutionPolicy Bypass -File watch-vesktop-vencord.ps1 -Register
        powershell -ExecutionPolicy Bypass -File watch-vesktop-vencord.ps1 -Unregister

.EXAMPLE
    .\watch-vesktop-vencord.ps1
#>
[CmdletBinding()]
param(
    [string]$Dist,
    [string]$Target,
    [switch]$Register,
    [switch]$Unregister,
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"

# $PSScriptRoot is not available in param() defaults on Windows PowerShell 5.1
if (-not $Dist) { $Dist = Join-Path $PSScriptRoot "..\..\Vencord\dist" }
if (-not $Target) { $Target = Join-Path $env:APPDATA "vesktop\vencord" }

$taskName = "MacroDeckBridge Vencord Watchdog"
$logFile = Join-Path $PSScriptRoot "watchdog.log"

if ($Unregister) {
    schtasks /delete /tn $taskName /f 2>$null
    Write-Host "Removed scheduled task '$taskName'."
    exit 0
}

if ($Register) {
    $arg = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    schtasks /create /tn $taskName /sc MINUTE /mo 5 /tr "powershell.exe $arg" /f | Out-Null
    schtasks /run /tn $taskName | Out-Null
    Write-Host "Registered scheduled task '$taskName' (every 5 minutes)."
    exit 0
}

function Write-Log([string]$Message) {
    if ($Quiet) { return }
    try {
        if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 512KB) {
            Remove-Item $logFile -Force
        }
        Add-Content -Path $logFile -Value ("{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message)
    } catch { }
}

if (-not (Test-Path (Join-Path $Dist "vencordDesktopRenderer.js"))) {
    Write-Log "skip: build not found at $Dist (run 'pnpm build --standalone' in Vencord first)"
    exit 0
}

$files = @(
    "vencordDesktopMain.js", "vencordDesktopMain.js.map", "vencordDesktopMain.js.LEGAL.txt",
    "vencordDesktopPreload.js", "vencordDesktopPreload.js.map",
    "vencordDesktopRenderer.js", "vencordDesktopRenderer.js.map", "vencordDesktopRenderer.js.LEGAL.txt",
    "vencordDesktopRenderer.css", "vencordDesktopRenderer.css.map"
)

New-Item -ItemType Directory -Force -Path $Target | Out-Null

$mismatch = @()
foreach ($f in $files) {
    $source = Join-Path $Dist $f
    $dest = Join-Path $Target $f
    if (-not (Test-Path $dest)) { $mismatch += $f; continue }
    if ((Get-FileHash $source).Hash -ne (Get-FileHash $dest).Hash) { $mismatch += $f }
}

$pkgPath = Join-Path $Target "package.json"
$pkgOk = (Test-Path $pkgPath) -and ((Get-Content $pkgPath -Raw).Trim() -eq "{}")
if ($mismatch.Count -eq 0 -and $pkgOk) { exit 0 }

# Restore everything (clear the read-only attribute first in case it was set).
foreach ($f in $files) {
    $dest = Join-Path $Target $f
    if (Test-Path $dest) { try { (Get-Item $dest).IsReadOnly = $false } catch { } }
    Copy-Item (Join-Path $Dist $f) $dest -Force
}

# Vesktop's isValidVencordInstall() requires a package.json; parse-safe BOM-less UTF-8.
[System.IO.File]::WriteAllText($pkgPath, "{}", (New-Object System.Text.UTF8Encoding($false)))

Write-Log ("restored {0} file(s) that had been replaced: {1}" -f $mismatch.Count, ($mismatch -join ", "))
Write-Host ("Restored MacroDeckBridge Vencord build in {0} ({1} file(s) fixed)." -f $Target, $mismatch.Count)
