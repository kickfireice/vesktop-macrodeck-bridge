#!/usr/bin/env bash
# =============================================================================
# setup.sh - One-command setup for Vesktop Bridge for Macro Deck (Linux).
#
# *** DISCLAIMER: NOT TESTED ON LINUX - ONLY TESTED ON WINDOWS 11. ***
# The tested path is setup.ps1 on Windows. This script is a best-effort port:
# it follows the same steps, but no one has run it end-to-end on Linux yet.
# If something breaks, the Windows script + README are the reference.
#
# All paths derive from this script's directory and $HOME/$XDG_CONFIG_HOME -
# nothing is hardcoded to any user. Needs: git, node >= 22, pnpm,
# .NET >= 10 SDK.
#
# Usage: ./setup.sh [--check-only] [--skip-macrodeck] [--skip-vesktop]
#                    [--skip-build] [--no-restart] [--register-watchdog]
#                    [--vencord-rev REV] [--vencord-dir DIR] [--target DIR]
#                    [--quiet]
# =============================================================================
set -uo pipefail

VENCORD_REV="auto"
VENCORD_DIR=""
TARGET=""
SKIP_MACRODECK=0
SKIP_VESKTOP=0
SKIP_BUILD=0
NO_RESTART=0
REGISTER_WATCHDOG=0
CHECK_ONLY=0
QUIET=0

while [ $# -gt 0 ]; do
    case "$1" in
        --vencord-rev) VENCORD_REV="${2:?missing value}"; shift 2 ;;
        --vencord-dir) VENCORD_DIR="${2:?missing value}"; shift 2 ;;
        --target) TARGET="${2:?missing value}"; shift 2 ;;
        --skip-macrodeck) SKIP_MACRODECK=1; shift ;;
        --skip-vesktop) SKIP_VESKTOP=1; shift ;;
        --skip-build) SKIP_BUILD=1; shift ;;
        --no-restart) NO_RESTART=1; shift ;;
        --register-watchdog) REGISTER_WATCHDOG=1; shift ;;
        --check-only) CHECK_ONLY=1; shift ;;
        --quiet) QUIET=1; shift ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
    esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
[ -z "$VENCORD_DIR" ] && VENCORD_DIR="$REPO_ROOT/Vencord"
[ -z "$TARGET" ] && TARGET="$CONFIG_HOME/vesktop/vencord"

REPO_PLUGIN_SRC="$REPO_ROOT/vesktop-plugin/userplugins/MacroDeckBridge"
MACRODECK_DIR="$REPO_ROOT/macrodeck-plugin"
WATCH_SCRIPT="$REPO_ROOT/vesktop-plugin/tools/watch-vesktop-vencord.sh"
VENCORD_REPO_URL="https://github.com/Vendicated/Vencord.git"

DIST_FILES="vencordDesktopMain.js vencordDesktopMain.js.map vencordDesktopMain.js.LEGAL.txt vencordDesktopPreload.js vencordDesktopPreload.js.map vencordDesktopRenderer.js vencordDesktopRenderer.js.map vencordDesktopRenderer.js.LEGAL.txt vencordDesktopRenderer.css vencordDesktopRenderer.css.map"

FAILURES=()

say() { [ "$QUIET" -eq 0 ] && echo "$1"; }
fail() { FAILURES+=("$1"); echo "WARNING: $1" >&2; }
have_cmd() { command -v "$1" >/dev/null 2>&1; }

# Find a Vesktop launcher. Prints "native:/path" or "flatpak:APPID", or nothing.
find_vesktop() {
    local bin
    for bin in vesktop /usr/bin/vesktop /usr/local/bin/vesktop /opt/Vesktop/vesktop "$HOME/.local/bin/vesktop"; do
        if [ -x "$bin" ] || have_cmd "$bin"; then echo "native:$bin"; return 0; fi
    done
    if have_cmd flatpak; then
        local id
        id="$(flatpak list --app --columns=application 2>/dev/null | grep -i vesktop | head -n1)"
        if [ -n "$id" ]; then echo "flatpak:$id"; return 0; fi
    fi
    return 1
}

# renderer_info <file> -> prints "exists size rev hasBridge(yes/no)"
renderer_info() {
    local f="$1" size rev bridge="no"
    [ -f "$f" ] || { echo "no 0 - no"; return 0; }
    size="$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null || echo 0)"
    rev="$(head -n1 "$f" 2>/dev/null | grep -o 'Vencord [0-9a-f]\{7,40\}' | awk '{print $2}')"
    [ -z "$rev" ] && rev="-"
    grep -q "MacroDeckBridge" "$f" 2>/dev/null && bridge="yes"
    echo "yes $size $rev $bridge"
}

test_prereqs() {
    local ok=1 cmd
    for cmd in git node pnpm; do
        if have_cmd "$cmd"; then say "  [ok] $cmd"
        elif [ "$cmd" = "pnpm" ]; then fail "Missing required tool: pnpm (try: corepack enable)"; ok=0
        else fail "Missing required tool: $cmd"; ok=0; fi
    done
    if [ "$SKIP_MACRODECK" -eq 0 ]; then
        if have_cmd dotnet; then
            say "  [ok] dotnet"
            local ver major
            ver="$(dotnet --version 2>/dev/null | tr -d '[:space:]')"
            major="${ver%%.*}"
            if [ -n "$major" ] && [ "$major" -ge 10 ] 2>/dev/null; then say "  [ok] dotnet $ver"
            else fail "dotnet SDK $ver is too old - need .NET 10 SDK or newer."; ok=0; fi
        else fail "Missing required tool: dotnet (.NET 10 SDK, https://dotnet.microsoft.com/download)"; ok=0; fi
    fi
    local nver nmajor
    nver="$(node --version 2>/dev/null | sed 's/^v//')"
    nmajor="${nver%%.*}"
    if [ -n "$nmajor" ] && [ "$nmajor" -ge 22 ] 2>/dev/null; then say "  [ok] node v$nver"
    else fail "node $nver is too old - need Node.js 22 or newer."; ok=0; fi
    if [ ! -d "$REPO_PLUGIN_SRC" ]; then fail "Plugin source missing: $REPO_PLUGIN_SRC"; ok=0; fi
    if ! find_vesktop >/dev/null; then
        say "  [warn] Vesktop not found - install it before the Vesktop half can deploy."
    fi
    if ! have_cmd macro-deck && ! pgrep -f -i macrodeck >/dev/null 2>&1; then
        say "  [warn] Macro Deck 3 not found - install it before the server half can run."
    fi
    return $((1 - ok))
}

deck_port() {
    local cfg="$CONFIG_HOME/DeckBridge/settings.json"
    SERVER_CFG="$cfg" node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.env.SERVER_CFG,"utf8")).ConfiguredPort||8323)}catch(e){console.log(8323)}' 2>/dev/null || echo 8323
}

check_listener() {
    # $1 = port. Uses node (already a prerequisite) - no ss/netstat dependency.
    CHECK_PORT="$1" node -e '
const n=require("net");
const s=n.connect(parseInt(process.env.CHECK_PORT,10),"127.0.0.1");
s.on("connect",()=>{s.destroy();process.exit(0);});
s.on("error",()=>process.exit(1));
setTimeout(()=>process.exit(1),3000);' 2>/dev/null
}

compare_tokens() {
    # exit 0 = match, 1 = mismatch, 2 = files unreadable
    SERVER_CFG="$CONFIG_HOME/DeckBridge/settings.json" CLIENT_CFG="$CONFIG_HOME/vesktop/settings/settings.json" node -e '
const fs=require("fs");
try{
 const a=JSON.parse(fs.readFileSync(process.env.SERVER_CFG,"utf8")).AuthToken;
 const b=JSON.parse(fs.readFileSync(process.env.CLIENT_CFG,"utf8")).plugins.MacroDeckBridge.token;
 process.exit(a&&a===b?0:1);
}catch(e){process.exit(2);}' 2>/dev/null
}

invoke_check_only() {
    say "=== CheckOnly: verifying install (no changes) ==="
    say "*** DISCLAIMER: NOT TESTED ON LINUX - ONLY TESTED ON WINDOWS 11. ***"
    say "-- prerequisites --"
    test_prereqs || true

    say "-- Vencord checkout --"
    if [ -d "$VENCORD_DIR/.git" ]; then
        local head
        head="$(git -C "$VENCORD_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')"
        say "  checkout rev: $head (expected $VENCORD_REV)"
        [ "$head" != "$VENCORD_REV" ] && fail "Vencord checkout is $head, expected $VENCORD_REV - re-run setup to rebuild."
    else
        fail "No Vencord checkout at $VENCORD_DIR - run setup without --check-only to clone it."
    fi

    say "-- builds --"
    local dist deployed
    dist="$(renderer_info "$VENCORD_DIR/dist/vencordDesktopRenderer.js")"
    deployed="$(renderer_info "$TARGET/vencordDesktopRenderer.js")"
    say "  dist:     $dist"
    say "  deployed: $deployed"
    [ "${dist##* }" != "yes" ] && fail "dist build lacks MacroDeckBridge - rebuild (run setup)."
    [ "${deployed##* }" != "yes" ] && fail "Deployed build lacks MacroDeckBridge - Vesktop overwrote it or setup never deployed. Run setup, then restart Vesktop."
    local drev brev
    drev="$(echo "$dist" | awk '{print $3}')"
    brev="$(echo "$deployed" | awk '{print $3}')"
    if [ "$drev" != "-" ] && [ "$brev" != "-" ] && [ "$drev" != "$brev" ]; then
        fail "Rev mismatch: dist=$drev deployed=$brev - Vesktop will replace the custom build. Redeploy + restart."
    fi

    say "-- Vesktop wiring --"
    local state_path="$CONFIG_HOME/vesktop/state.json"
    if [ -f "$state_path" ]; then
        local vdir
        vdir="$(STATE_PATH="$state_path" node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.env.STATE_PATH,"utf8")).vencordDir||"")}catch(e){console.log("")}' 2>/dev/null)"
        say "  vencordDir: $vdir"
        [ "$vdir" != "$TARGET" ] && fail "state.json vencordDir points elsewhere - run setup to fix."
    else
        fail "Vesktop state.json not found - is Vesktop installed?"
    fi

    say "-- token pairing --"
    if [ -f "$CONFIG_HOME/DeckBridge/settings.json" ] && [ -f "$CONFIG_HOME/vesktop/settings/settings.json" ]; then
        local rc=0
        compare_tokens || rc=$?
        if [ "$rc" -eq 0 ]; then say "  [ok] tokens match"
        elif [ "$rc" -eq 1 ]; then fail "Token mismatch between Macro Deck server and Vesktop client - re-copy the token (README step 3)."
        else fail "Cannot compare tokens (parse error)."; fi
    else
        say "  [skip] token files not both present yet (start both apps once first)."
    fi

    say "-- listener --"
    local port
    port="$(deck_port)"
    if check_listener "$port"; then say "  [ok] something is listening on 127.0.0.1:$port"
    else fail "Nothing listening on port $port - is the Macro Deck plugin running?"; fi

    if [ "${#FAILURES[@]}" -eq 0 ]; then say "ALL CHECKS PASSED."; exit 0
    else echo "WARNING: ${#FAILURES[@]} check(s) failed." >&2; exit 1; fi
}

# ---------------------------------------------------------------- main ------

if [ "$CHECK_ONLY" -eq 1 ]; then invoke_check_only; fi

say "=== Vesktop Bridge setup (Linux) ==="
say "*** DISCLAIMER: NOT TESTED ON LINUX - ONLY TESTED ON WINDOWS 11. ***"
say "Repo:   $REPO_ROOT"
say "Vencord rev: $VENCORD_REV"
say "-- prerequisites --"
if ! test_prereqs; then echo "Prerequisites missing (see warnings above). Install them and re-run." >&2; exit 1; fi

if [ "$SKIP_MACRODECK" -eq 0 ]; then
    say "-- Macro Deck plugin: dotnet build --"
    dotnet build "$MACRODECK_DIR/VesktopBridge.slnx" || { echo "dotnet build failed." >&2; exit 1; }
    say "Macro Deck plugin built. Install/pack it into Macro Deck, then copy its token (README step 1)."
fi

if [ "$SKIP_VESKTOP" -eq 0 ]; then
    say "-- Vesktop client plugin --"
    # "auto" (default): use whatever rev Vesktop currently ships, read from the
    # deployed build's header - so a Vesktop update just means re-running setup.
    if [ "$VENCORD_REV" = "auto" ]; then
        dep_rev="$(head -n1 "$TARGET/vencordDesktopRenderer.js" 2>/dev/null | grep -o 'Vencord [0-9a-f]\{7,40\}' | awk '{print $2}')"
        if [ -n "$dep_rev" ]; then
            VENCORD_REV="$dep_rev"
            say "Auto-detected Vencord rev $VENCORD_REV from the deployed build."
        else
            VENCORD_REV="3374b8a"
            say "No deployed build found - defaulting to Vencord rev $VENCORD_REV."
        fi
    fi
    if [ ! -d "$VENCORD_DIR/.git" ]; then
        say "Cloning Vencord (build dependency, gitignored) ..."
        git clone "$VENCORD_REPO_URL" "$VENCORD_DIR" || { echo "Vencord clone failed." >&2; exit 1; }
    fi
    head="$(git -C "$VENCORD_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')"
    if [ "$head" != "$VENCORD_REV" ]; then
        say "Checking out Vencord rev $VENCORD_REV (current: $head) ..."
        git -C "$VENCORD_DIR" fetch origin --quiet
        git -C "$VENCORD_DIR" checkout "$VENCORD_REV" --quiet || { echo "Cannot check out Vencord rev $VENCORD_REV." >&2; exit 1; }
    fi

    dest="$VENCORD_DIR/src/userplugins/MacroDeckBridge"
    mkdir -p "$dest"
    cp -rf "$REPO_PLUGIN_SRC/." "$dest/"
    say "Userplugin copied."

    if [ "$SKIP_BUILD" -eq 0 ]; then
        say "Building Vencord (pnpm install + pnpm build --standalone) ..."
        (cd "$VENCORD_DIR" && pnpm install && pnpm build --standalone) || { echo "Vencord build failed." >&2; exit 1; }
    fi

    info="$(renderer_info "$VENCORD_DIR/dist/vencordDesktopRenderer.js")"
    dsize="$(echo "$info" | awk '{print $2}')"
    drev="$(echo "$info" | awk '{print $3}')"
    dbridge="$(echo "$info" | awk '{print $4}')"
    [ "$dbridge" != "yes" ] && { echo "Build lacks MacroDeckBridge - aborting before deploy." >&2; exit 1; }
    say "Built: size=$dsize rev=$drev hasBridge=$dbridge"

    say "Stopping Vesktop (it rewrites state.json on exit) ..."
    pkill -x vesktop 2>/dev/null || true
    sleep 3

    mkdir -p "$TARGET"
    # shellcheck disable=SC2086
    for f in $DIST_FILES; do
        cp -f "$VENCORD_DIR/dist/$f" "$TARGET/$f"
    done
    printf '%s' '{}' >"$TARGET/package.json"
    say "Deployed to $TARGET."

    state_path="$CONFIG_HOME/vesktop/state.json"
    [ -f "$state_path" ] && cp -f "$state_path" "$state_path.bak"
    STATE_PATH="$state_path" TARGET_DIR="$TARGET" node -e '
const fs=require("fs");
const sp=process.env.STATE_PATH;
let s={};
try{ s=JSON.parse(fs.readFileSync(sp,"utf8")); }catch(e){ s={}; }
s.vencordDir=process.env.TARGET_DIR;
fs.writeFileSync(sp,JSON.stringify(s,null,2));'
    say "Set vencordDir in state.json."

    # The watchdog timer stores an ABSOLUTE ExecStart path. If the repo was
    # moved/renamed, a stale timer keeps pointing at the old location, so
    # re-running setup must heal it even without --register-watchdog.
    if [ "$REGISTER_WATCHDOG" -eq 1 ]; then
        if [ -f "$WATCH_SCRIPT" ]; then
            say "Registering Vencord watchdog (self-heals stock overwrites) ..."
            "$WATCH_SCRIPT" --register || echo "WARNING: watchdog registration failed." >&2
        else
            echo "WARNING: watchdog script not found: $WATCH_SCRIPT" >&2
        fi
    else
        unit_file="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/macrodeckbridge-watch.service"
        if [ -f "$unit_file" ]; then
            if ! grep -qF "ExecStart=$WATCH_SCRIPT" "$unit_file" 2>/dev/null; then
                say "Watchdog timer points elsewhere (repo moved?) - re-registering at new location ..."
                say "  new: $WATCH_SCRIPT"
                if [ -f "$WATCH_SCRIPT" ]; then
                    "$WATCH_SCRIPT" --register || echo "WARNING: watchdog re-registration failed." >&2
                else
                    echo "WARNING: watchdog timer is stale but $WATCH_SCRIPT is missing." >&2
                fi
            fi
        fi
    fi

    if [ "$NO_RESTART" -eq 0 ]; then
        launcher="$(find_vesktop || true)"
        if [ -n "$launcher" ]; then
            say "Starting Vesktop ..."
            case "$launcher" in
                native:*) nohup "${launcher#native:}" >/dev/null 2>&1 & disown ;;
                flatpak:*) nohup flatpak run "${launcher#flatpak:}" >/dev/null 2>&1 & disown ;;
            esac
            sleep 12
            ainfo="$(renderer_info "$TARGET/vencordDesktopRenderer.js")"
            arev="$(echo "$ainfo" | awk '{print $3}')"
            abridge="$(echo "$ainfo" | awk '{print $4}')"
            if [ "$abridge" != "yes" ]; then
                fail "Vesktop replaced the custom build on launch (rev drift?) - run the watchdog script, then re-run setup with the new rev."
            else
                say "Deployed build survived the restart (rev $arev). Enable MacroDeckBridge in Vesktop Settings -> Plugins, then pair the token (README step 3)."
            fi
            # Flatpak sandboxes may hide the custom dir - call it out, do not guess.
            case "$launcher" in flatpak:*) say "  [warn] Flatpak install: if the plugin does not appear, the sandbox may need a filesystem override for $TARGET." ;; esac
        else
            say "Vesktop not found - start it manually after installing it."
        fi
    else
        say "Skipping Vesktop restart (--no-restart). Start Vesktop manually."
    fi
fi

if [ "${#FAILURES[@]}" -gt 0 ]; then echo "WARNING: setup finished with warnings." >&2; exit 1; fi
say "=== Setup complete ==="
