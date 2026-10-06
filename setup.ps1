<#
.SYNOPSIS
    One-command setup for Vesktop Bridge for Macro Deck (Macro Deck + Vesktop halves).

.DESCRIPTION
    Builds and wires up both halves on the current PC. All paths are derived
    from this script's location ($PSScriptRoot) and environment variables
    ($env:APPDATA, $env:LOCALAPPDATA) - nothing is hardcoded to any user.

    Steps:
      1. Check prerequisites (Git, Node, pnpm, .NET SDK).
      2. Build the Macro Deck plugin  (macrodeck-plugin\VesktopBridge.slnx).
      3. Clone Vencord at the rev Vesktop ships (if missing), copy in the
         MacroDeckBridge userplugin, and run 'pnpm build --standalone'.
      4. Deploy the build to Vesktop's Vencord dir, point Vesktop at it
         (state.json vencordDir, BOM-less UTF-8), and restart Vesktop.
      5. Verify: dist/deployed rev + MacroDeckBridge marker, token match,
         listening port.

    The Vencord rev MUST match the one Vesktop ships, otherwise Vesktop's
    startup updater silently replaces the custom build with stock Vencord on
    every launch. If Vesktop updated and the plugin vanished, re-run this
    script with the new rev (see -VencordRev).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\setup.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\setup.ps1 -CheckOnly
    Verify only; changes nothing.
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\setup.ps1 -VencordRev 3374b8a -RegisterWatchdog
    (omit -VencordRev to auto-detect it from the deployed build)
#>
[CmdletBinding()]
param(
    [string]$VencordRev = "auto",
    [string]$VencordDir = "",
    [string]$Target = "",
    [switch]$SkipMacroDeck,
    [switch]$SkipVesktop,
    [switch]$SkipBuild,
    [switch]$NoRestart,
    [switch]$RegisterWatchdog,
    [switch]$CheckOnly,
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"

# $PSScriptRoot is not available in param() defaults on Windows PowerShell 5.1.
# Fall back to the launch directory if it is ever empty (e.g. pasted into a console).
$RepoRoot = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
if (-not $VencordDir) { $VencordDir = Join-Path $RepoRoot "Vencord" }
if (-not $Target) { $Target = Join-Path $env:APPDATA "vesktop\vencord" }

$RepoPluginSrc = Join-Path $RepoRoot "vesktop-plugin\userplugins\MacroDeckBridge"
$MacroDeckDir = Join-Path $RepoRoot "macrodeck-plugin"
$WatchScript = Join-Path $RepoRoot "vesktop-plugin\tools\watch-vesktop-vencord.ps1"
$WatchVbs = Join-Path $RepoRoot "vesktop-plugin\tools\run-hidden.vbs"
$WatchTaskName = "MacroDeckBridge Vencord Watchdog"
$VesktopExe = Join-Path $env:LOCALAPPDATA "vesktop\vesktop.exe"
$MacroDeckExe = Join-Path $env:LOCALAPPDATA "Macro Deck\MacroDeck.exe"
$VencordRepoUrl = "https://github.com/Vendicated/Vencord.git"

$DistFiles = @(
    "vencordDesktopMain.js", "vencordDesktopMain.js.map", "vencordDesktopMain.js.LEGAL.txt",
    "vencordDesktopPreload.js", "vencordDesktopPreload.js.map",
    "vencordDesktopRenderer.js", "vencordDesktopRenderer.js.map", "vencordDesktopRenderer.js.LEGAL.txt",
    "vencordDesktopRenderer.css", "vencordDesktopRenderer.css.map"
)

$script:Failures = @()

function Say([string]$Message) {
    if (-not $Quiet) { Write-Host $Message }
}

function Fail([string]$Message) {
    $script:Failures += $Message
    Write-Warning $Message
}

function HaveCommand([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
    # Vesktop parses state.json / package.json with JSON.parse - a UTF-8 BOM breaks it.
    [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-RendererInfo([string]$Path) {
    # Returns size, header rev (first line "// Vencord <rev>"), and bridge marker.
    $result = @{ Exists = $false; Size = 0; Rev = ""; HasBridge = $false }
    if (-not (Test-Path $Path)) { return $result }
    $result.Exists = $true
    $result.Size = (Get-Item $Path).Length
    try { $first = Get-Content $Path -TotalCount 1 -ErrorAction Stop } catch { $first = "" }
    if ($first -match "Vencord\s+([0-9a-f]{7,40})") { $result.Rev = $Matches[1] }
    try {
        $text = [System.IO.File]::ReadAllText($Path)
        $result.HasBridge = $text.Contains("MacroDeckBridge")
    } catch { }
    return $result
}

function Resolve-VencordRev {
    # "auto" (default): use whatever rev Vesktop currently ships, read from the
    # deployed build's header - so a Vesktop update just means re-running setup.
    if ($VencordRev -ne "auto") { return $VencordRev }
    $depInfo = Get-RendererInfo (Join-Path $Target "vencordDesktopRenderer.js")
    if ($depInfo.Rev -ne "") {
        Say "Auto-detected Vencord rev $($depInfo.Rev) from the deployed build."
        return $depInfo.Rev
    }
    Say "No deployed build found - defaulting to Vencord rev 3374b8a."
    return "3374b8a"
}

function Get-WatchdogTaskTarget {
    # Returns the .vbs path the scheduled watchdog task points at, or $null if
    # no task is registered. Namespace-agnostic (schtasks XML has a default ns).
    try {
        $out = (& schtasks /query /tn $WatchTaskName /xml 2>$null) -join "`n"
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($out)) { return $null }
        [xml]$doc = $out
        $argsNode = $doc.GetElementsByTagName("Arguments") | Select-Object -First 1
        if ($null -eq $argsNode) { return $null }
        $raw = $argsNode.InnerText.Trim()
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        # Arguments is just the quoted/unquoted .vbs path (command is wscript.exe).
        # Take the first quoted token if present, else the first whitespace token.
        $m = [regex]::Match($raw, '"([^"]+\.vbs)"')
        if ($m.Success) { return $m.Groups[1].Value }
        $tok = ($raw -split '\s+')[0].Trim('"')
        if ($tok -like "*.vbs") { return $tok }
        return $raw.Trim('"')
    } catch { return $null }
}

function Sync-WatchdogTask {
    # Self-heals a stale watchdog registration (e.g. repo was moved/renamed).
    # The task stores an ABSOLUTE path to run-hidden.vbs, so moving the repo
    # without re-registering leaves a task that pops "Can not find script file"
    # every 5 minutes. Re-running setup must heal it even without -RegisterWatchdog.
    param([bool]$WantRegister)
    $existing = Get-WatchdogTaskTarget
    if ($WantRegister) {
        if (Test-Path $WatchScript) {
            Say "Registering Vencord watchdog (self-heals stock overwrites) ..."
            & powershell -ExecutionPolicy Bypass -File $WatchScript -Register
        } else {
            Write-Warning "Watchdog script not found: $WatchScript"
        }
        return
    }
    if ($null -eq $existing) { return }
    $normExisting = $existing.Trim().Trim('"')
    if ($normExisting -ieq $WatchVbs.Trim()) { return }
    # Task points elsewhere - stale after a move/rename, or from another copy.
    if (-not (Test-Path $normExisting)) {
        Say ("Watchdog task points to a missing file (repo moved?):`n  old: $normExisting`n  new: $WatchVbs")
        Say "Re-registering the watchdog at the new location ..."
    } else {
        Say ("Watchdog task points to another copy:`n  task: $normExisting`n  repo: $WatchVbs")
        Say "Updating the watchdog to this repo copy ..."
    }
    if (Test-Path $WatchScript) {
        & powershell -ExecutionPolicy Bypass -File $WatchScript -Register
    } else {
        Fail "Watchdog task is stale but $WatchScript is missing - remove the old task manually: schtasks /delete /tn '$WatchTaskName' /f"
    }
}

function Test-Prereqs {
    $ok = $true
    foreach ($cmd in @("git", "node", "pnpm")) {
        if (HaveCommand $cmd) { Say "  [ok] $cmd" }
        elseif ($cmd -eq "pnpm") { Fail "Missing required tool: pnpm (try: corepack enable)"; $ok = $false }
        else { Fail "Missing required tool: $cmd"; $ok = $false }
    }
    if (-not $SkipMacroDeck) {
        if (HaveCommand "dotnet") {
            Say "  [ok] dotnet"
            try {
                $ver = (& dotnet --version 2>$null).Trim()
                $major = ([version]$ver.Split("-")[0]).Major
                if ($major -lt 10) { Fail "dotnet SDK $ver is too old - need .NET 10 SDK or newer."; $ok = $false }
                else { Say "  [ok] dotnet $ver" }
            } catch { Say "  [warn] cannot read dotnet version - continuing." }
        }
        else { Fail "Missing required tool: dotnet (.NET 10 SDK from https://dotnet.microsoft.com/download)"; $ok = $false }
    }
    try {
        $nodeVer = (& node --version 2>$null).Trim().TrimStart("v")
        $nodeMajor = ([version]$nodeVer).Major
        if ($nodeMajor -lt 22) { Fail "node $nodeVer is too old - need Node.js 22 or newer."; $ok = $false }
        else { Say "  [ok] node v$nodeVer" }
    } catch { Fail "Cannot read node version."; $ok = $false }
    if (-not (Test-Path $RepoPluginSrc)) {
        Fail "Plugin source missing: $RepoPluginSrc"
        $ok = $false
    }
    if ((-not (Test-Path $VesktopExe)) -and (-not (Get-Process vesktop -ErrorAction SilentlyContinue))) {
        Say "  [warn] Vesktop not found - install it before the Vesktop half can deploy."
    }
    if ((-not (Test-Path $MacroDeckExe)) -and (-not (Get-Process MacroDeck* -ErrorAction SilentlyContinue))) {
        Say "  [warn] Macro Deck 3 not found - install it before the server half can run."
    }
    return $ok
}

function Invoke-CheckOnly {
    Say "=== CheckOnly: verifying install (no changes) ==="
    Say "-- prerequisites --"
    Test-Prereqs | Out-Null

    Say "-- Vencord checkout --"
    $wantRev = Resolve-VencordRev
    $checkout = Join-Path $VencordDir ".git"
    if (Test-Path $checkout) {
        try {
            $head = (& git -C $VencordDir rev-parse --short HEAD 2>$null)
            Say "  checkout rev: $head (expected $wantRev)"
            if ($head -ne $wantRev) { Fail "Vencord checkout is $head, expected $wantRev - re-run setup to rebuild." }
        } catch { Fail "Cannot read Vencord checkout rev." }
    } else {
        Fail "No Vencord checkout at $VencordDir - run setup without -CheckOnly to clone it."
    }

    Say "-- builds --"
    $dist = Get-RendererInfo (Join-Path $VencordDir "dist\vencordDesktopRenderer.js")
    $deployed = Get-RendererInfo (Join-Path $Target "vencordDesktopRenderer.js")
    Say ("  dist:     size={0} rev={1} hasBridge={2}" -f $dist.Size, $dist.Rev, $dist.HasBridge)
    Say ("  deployed: size={0} rev={1} hasBridge={2}" -f $deployed.Size, $deployed.Rev, $deployed.HasBridge)
    if (-not $dist.HasBridge) { Fail "dist build lacks MacroDeckBridge - rebuild (run setup)." }
    if (-not $deployed.HasBridge) { Fail "Deployed build lacks MacroDeckBridge - Vesktop overwrote it or setup never deployed. Run setup, then restart Vesktop." }
    if ($dist.Exists -and $deployed.Exists -and ($dist.Rev -ne $deployed.Rev)) {
        Fail ("Rev mismatch: dist={0} deployed={1} - Vesktop will replace the custom build. Redeploy + restart." -f $dist.Rev, $deployed.Rev)
    }

    Say "-- Vesktop wiring --"
    $statePath = Join-Path $env:APPDATA "vesktop\state.json"
    if (Test-Path $statePath) {
        try {
            $state = Get-Content $statePath -Raw | ConvertFrom-Json
            Say ("  vencordDir: {0}" -f $state.vencordDir)
            if ($state.vencordDir -ne $Target) { Fail "state.json vencordDir points elsewhere - run setup to fix." }
        } catch { Fail "Cannot parse $statePath." }
    } else {
        Fail "Vesktop state.json not found - is Vesktop installed?"
    }

    Say "-- token pairing --"
    $deckSettings = Join-Path $env:APPDATA "DeckBridge\settings.json"
    $vencordSettings = Join-Path $env:APPDATA "Vesktop\settings\settings.json"
    if ((Test-Path $deckSettings) -and (Test-Path $vencordSettings)) {
        try {
            $serverToken = (Get-Content $deckSettings -Raw | ConvertFrom-Json).AuthToken
            $clientToken = (Get-Content $vencordSettings -Raw | ConvertFrom-Json).plugins.MacroDeckBridge.token
            if ($serverToken -and ($serverToken -eq $clientToken)) { Say "  [ok] tokens match" }
            else { Fail "Token mismatch between Macro Deck server and Vesktop client - re-copy the token (README step 3)." }
        } catch { Fail "Cannot compare tokens (parse error)." }
    } else {
        Say "  [skip] token files not both present yet (start both apps once first)."
    }

    Say "-- listener --"
    $listening = Get-NetTCPConnection -LocalPort 8323 -State Listen -ErrorAction SilentlyContinue
    if ($listening) { Say "  [ok] something is listening on 127.0.0.1:8323" }
    else { Fail "Nothing listening on port 8323 - is the Macro Deck plugin running?" }

    Say "-- watchdog --"
    $taskTarget = Get-WatchdogTaskTarget
    if ($null -eq $taskTarget) {
        Say "  [skip] watchdog scheduled task not registered (opt-in via -RegisterWatchdog)."
    } elseif ($taskTarget.Trim().Trim('"') -ieq $WatchVbs.Trim()) {
        if (Test-Path $WatchVbs) { Say "  [ok] watchdog points at this repo copy" }
        else { Fail "Watchdog task points here but $WatchVbs is missing." }
    } else {
        Fail ("Watchdog task is stale (points at {0}, this repo is {1}) - re-run setup (it self-heals) or run the watch script with -Register." -f $taskTarget, $WatchVbs)
    }

    if ($script:Failures.Count -eq 0) { Say "ALL CHECKS PASSED."; exit 0 }
    else { Write-Warning ("{0} check(s) failed." -f $script:Failures.Count); exit 1 }
}

# ---------------------------------------------------------------- main ------

if ($CheckOnly) { Invoke-CheckOnly }

Say "=== Vesktop Bridge setup ==="
Say "Repo:   $RepoRoot"
Say "Vencord rev: $VencordRev"
Say "-- prerequisites --"
if (-not (Test-Prereqs)) { throw "Prerequisites missing (see warnings above). Install them and re-run." }

if (-not $SkipMacroDeck) {
    Say "-- Macro Deck plugin: dotnet build --"
    & dotnet build (Join-Path $MacroDeckDir "VesktopBridge.slnx")
    if ($LASTEXITCODE -ne 0) { throw "dotnet build failed." }
    Say "Macro Deck plugin built. Install/pack it into Macro Deck, then copy its token (README step 1)."
}

if (-not $SkipVesktop) {
    Say "-- Vesktop client plugin --"
    $VencordRev = Resolve-VencordRev
    if (-not (Test-Path (Join-Path $VencordDir ".git"))) {
        Say "Cloning Vencord (build dependency, gitignored) ..."
        & git clone $VencordRepoUrl $VencordDir
        if ($LASTEXITCODE -ne 0) { throw "Vencord clone failed." }
    }
    $head = (& git -C $VencordDir rev-parse --short HEAD 2>$null)
    if ($head -ne $VencordRev) {
        Say "Checking out Vencord rev $VencordRev (current: $head) ..."
        & git -C $VencordDir fetch origin --quiet
        & git -C $VencordDir checkout $VencordRev --quiet
        if ($LASTEXITCODE -ne 0) { throw "Cannot check out Vencord rev $VencordRev." }
    }

    $dest = Join-Path $VencordDir "src\userplugins\MacroDeckBridge"
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item -Recurse -Force (Join-Path $RepoPluginSrc "*") $dest
    Say "Userplugin copied."

    if (-not $SkipBuild) {
        Say "Building Vencord (pnpm install + pnpm build --standalone) ..."
        & pnpm --dir $VencordDir install
        if ($LASTEXITCODE -ne 0) { throw "pnpm install failed in $VencordDir." }
        & pnpm --dir $VencordDir build --standalone
        if ($LASTEXITCODE -ne 0) { throw "pnpm build --standalone failed." }
    }

    $distInfo = Get-RendererInfo (Join-Path $VencordDir "dist\vencordDesktopRenderer.js")
    if (-not $distInfo.HasBridge) { throw "Build lacks MacroDeckBridge - aborting before deploy." }
    Say ("Built: size={0} rev={1} hasBridge={2}" -f $distInfo.Size, $distInfo.Rev, $distInfo.HasBridge)

    Say "Stopping Vesktop (it rewrites state.json on exit) ..."
    Stop-Process -Name vesktop -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3

    New-Item -ItemType Directory -Force -Path $Target | Out-Null
    foreach ($f in $DistFiles) {
        Copy-Item (Join-Path $VencordDir "dist\$f") (Join-Path $Target $f) -Force
    }
    Write-Utf8NoBom (Join-Path $Target "package.json") "{}"
    Say "Deployed to $Target."

    $statePath = Join-Path $env:APPDATA "vesktop\state.json"
    $state = if (Test-Path $statePath) { Get-Content $statePath -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
    if ($state.PSObject.Properties.Name -notcontains "vencordDir") {
        $state | Add-Member -NotePropertyName vencordDir -NotePropertyValue $Target
    } else {
        $state.vencordDir = $Target
    }
    if (Test-Path $statePath) { Copy-Item $statePath "$statePath.bak" -Force }
    Write-Utf8NoBom $statePath ($state | ConvertTo-Json -Depth 10)
    Say "Set vencordDir in state.json."

    Sync-WatchdogTask -WantRegister ([bool]$RegisterWatchdog)

    if (-not $NoRestart) {
        if (Test-Path $VesktopExe) {
            Say "Starting Vesktop (detached - safe to close this window) ..."
            # Detached launch: cmd's `start` breaks away from this console's job
            # object, so closing the setup window does NOT kill Vesktop.
            # (Plain Start-Process keeps Vesktop as a console child - closing the
            # console then takes Vesktop down with it.)
            & cmd.exe /c start '""' "`"$VesktopExe`""
            Start-Sleep -Seconds 12
            $after = Get-RendererInfo (Join-Path $Target "vencordDesktopRenderer.js")
            if (-not $after.HasBridge) {
                Fail "Vesktop replaced the custom build on launch (rev drift?) - run the watchdog script, then re-run setup with the new rev."
            } else {
                Say "Deployed build survived the restart. Enable MacroDeckBridge in Vesktop Settings -> Plugins, then pair the token (README step 3)."
            }
        } else {
            Say "Vesktop not found at $VesktopExe - start it manually after installing it."
        }
    } else {
        Say "Skipping Vesktop restart (-NoRestart). Start Vesktop manually."
    }
}

if ($script:Failures.Count -gt 0) { Write-Warning "Setup finished with warnings."; exit 1 }
Say "=== Setup complete ==="
