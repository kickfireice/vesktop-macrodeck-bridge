<#
.SYNOPSIS
    Keeps Vesktop's Vencord files in sync with the locally built Vencord
    (the one containing the MacroDeckBridge userplugin).

.DESCRIPTION
    Vesktop loads Vencord from:  State.store.vencordDir || <sessionData>\vencordFiles

    Vesktop's menu item "Force Update Vencord" (and `vesktop --repair`) calls its
    internal downloadVencordFiles(), which OVERWRITES vencordDesktop*.js/css in
    that directory with the official Vencord release - silently removing custom
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
    # Launch via wscript + run-hidden.vbs (both windowless). A direct
    # powershell.exe task action flashes a console window every run because
    # conhost appears before -WindowStyle Hidden applies.
    $vbs = Join-Path $PSScriptRoot "run-hidden.vbs"
    if (-not (Test-Path $vbs)) { throw "run-hidden.vbs missing next to $PSCommandPath" }
    $arg = 'wscript.exe "' + $vbs + '"'
    schtasks /create /tn $taskName /sc MINUTE /mo 5 /tr "$arg" /f | Out-Null
    schtasks /run /tn $taskName | Out-Null
    Write-Host "Registered scheduled task '$taskName' (every 5 minutes, hidden)."
    exit 0
}

function Get-BuildInfo([string]$Dir) {
    # Rev from the "// Vencord <rev>" header + whether the bridge is compiled in.
    $info = @{ Rev = ""; HasBridge = $false }
    $renderer = Join-Path $Dir "vencordDesktopRenderer.js"
    if (-not (Test-Path $renderer)) { return $info }
    try {
        $first = Get-Content $renderer -TotalCount 1 -ErrorAction Stop
        if ($first -match "Vencord\s+([0-9a-f]{7,40})") { $info.Rev = $Matches[1] }
        $info.HasBridge = [System.IO.File]::ReadAllText($renderer).Contains("MacroDeckBridge")
    } catch { }
    return $info
}

function Show-Toast([string]$Title, [string]$Message) {
    # No-module balloon tip: works from the hidden scheduled task (user session).
    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $notify = New-Object System.Windows.Forms.NotifyIcon
        $notify.Icon = [System.Drawing.SystemIcons]::Information
        $notify.BalloonTipTitle = $Title
        $notify.BalloonTipText = $Message
        $notify.Visible = $true
        $notify.ShowBalloonTip(10000)
        Start-Sleep -Seconds 11
        $notify.Dispose()
    } catch { }
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

# Rev drift: Vesktop replaced the build with a NEWER stock Vencord (different
# rev than our build). Restoring stale files is pointless - Vesktop wipes them
# again on next boot. Notify instead of restoring.
$distInfo = Get-BuildInfo $Dist
$deployedInfo = Get-BuildInfo $Target
if (-not $deployedInfo.HasBridge -and $deployedInfo.Rev -ne "" -and $deployedInfo.Rev -ne $distInfo.Rev) {
    $msg = "Vesktop updated Vencord to rev {0} (build is {1}). Run setup.ps1 to rebuild - restoring is skipped until then." -f $deployedInfo.Rev, $distInfo.Rev
    Write-Log ("REV DRIFT: " + $msg)
    Write-Host $msg
    Show-Toast "Vesktop Bridge" $msg
    exit 0
}

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
