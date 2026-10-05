#!/usr/bin/env bash
# =============================================================================
# watch-vesktop-vencord.sh - Keeps Vesktop's Vencord files in sync with the
# locally built Vencord (the one containing the MacroDeckBridge userplugin).
#
# *** DISCLAIMER: NOT TESTED ON LINUX - ONLY TESTED ON WINDOWS 11. ***
# The tested twin of this script is watch-vesktop-vencord.ps1 on Windows.
#
# Vesktop loads Vencord from state.json's vencordDir and its startup updater
# can OVERWRITE that directory with the stock release, silently removing
# custom builds like this plugin. This script compares the deployed files
# against the local dist/ build and restores them when they differ, then
# ensures package.json exists (Vesktop requires it).
#
# Usage:
#   ./watch-vesktop-vencord.sh [DIST] [TARGET]   # one-shot heal
#   ./watch-vesktop-vencord.sh --register        # systemd user timer, every 5 min
#   ./watch-vesktop-vencord.sh --unregister      # remove the timer again
# =============================================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="${1:-$SCRIPT_DIR/../../Vencord/dist}"
TARGET="${2:-${XDG_CONFIG_HOME:-$HOME/.config}/vesktop/vencord}"
LOG_FILE="$SCRIPT_DIR/watchdog.log"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

FILES="vencordDesktopMain.js vencordDesktopMain.js.map vencordDesktopMain.js.LEGAL.txt vencordDesktopPreload.js vencordDesktopPreload.js.map vencordDesktopRenderer.js vencordDesktopRenderer.js.map vencordDesktopRenderer.js.LEGAL.txt vencordDesktopRenderer.css vencordDesktopRenderer.css.map"

log_msg() {
    if [ -f "$LOG_FILE" ]; then
        local size
        size="$(stat -c%s "$LOG_FILE" 2>/dev/null || stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)"
        [ "$size" -gt 524288 ] && rm -f "$LOG_FILE"
    fi
    echo "$(date '+%Y-%m-%d %H:%M:%S')  $1" >>"$LOG_FILE"
}

do_register() {
    mkdir -p "$UNIT_DIR"
    cat >"$UNIT_DIR/macrodeckbridge-watch.service" <<EOF
[Unit]
Description=Restore MacroDeckBridge custom Vencord build for Vesktop

[Service]
Type=oneshot
ExecStart=$SCRIPT_DIR/watch-vesktop-vencord.sh
EOF
    cat >"$UNIT_DIR/macrodeckbridge-watch.timer" <<EOF
[Unit]
Description=Check MacroDeckBridge Vencord build every 5 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF
    if command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload 2>/dev/null; then
        systemctl --user enable --now macrodeckbridge-watch.timer
        echo "Registered user timer 'macrodeckbridge-watch.timer' (every 5 minutes)."
    else
        echo "No working systemd user instance. Use cron instead:" >&2
        echo "  (crontab -l 2>/dev/null; echo '*/5 * * * * $SCRIPT_DIR/watch-vesktop-vencord.sh >/dev/null 2>&1') | crontab -" >&2
        exit 1
    fi
}

do_unregister() {
    if command -v systemctl >/dev/null 2>&1; then
        systemctl --user disable --now macrodeckbridge-watch.timer 2>/dev/null || true
    fi
    rm -f "$UNIT_DIR/macrodeckbridge-watch.service" "$UNIT_DIR/macrodeckbridge-watch.timer"
    echo "Removed user timer 'macrodeckbridge-watch.timer'."
}

case "${1:-}" in
    --register) do_register; exit 0 ;;
    --unregister) do_unregister; exit 0 ;;
esac

if [ ! -f "$DIST/vencordDesktopRenderer.js" ]; then
    log_msg "skip: build not found at $DIST (build Vencord first)"
    exit 0
fi

mkdir -p "$TARGET"

mismatch=""
for f in $FILES; do
    if [ ! -f "$TARGET/$f" ]; then mismatch="$mismatch $f"
    elif ! cmp -s "$DIST/$f" "$TARGET/$f"; then mismatch="$mismatch $f"
    fi
done

pkg_ok=0
if [ -f "$TARGET/package.json" ]; then
    content="$(tr -d '[:space:]' <"$TARGET/package.json")"
    [ "$content" = "{}" ] && pkg_ok=1
fi

if [ -z "$mismatch" ] && [ "$pkg_ok" -eq 1 ]; then exit 0; fi

# Rev drift: Vesktop replaced the build with a NEWER stock Vencord (different
# rev than our build). Restoring stale files is pointless - Vesktop wipes them
# again on next boot. Log it (journalctl/cron mail) instead of restoring.
dist_rev="$(head -n1 "$DIST/vencordDesktopRenderer.js" 2>/dev/null | grep -o 'Vencord [0-9a-f]\{7,40\}' | awk '{print $2}')"
deployed_has_bridge=0
grep -q "MacroDeckBridge" "$TARGET/vencordDesktopRenderer.js" 2>/dev/null && deployed_has_bridge=1
deployed_rev="$(head -n1 "$TARGET/vencordDesktopRenderer.js" 2>/dev/null | grep -o 'Vencord [0-9a-f]\{7,40\}' | awk '{print $2}')"
if [ "$deployed_has_bridge" -eq 0 ] && [ -n "$deployed_rev" ] && [ "$deployed_rev" != "$dist_rev" ]; then
    log_msg "REV DRIFT: Vesktop updated Vencord to rev $deployed_rev (build is $dist_rev). Re-run setup.sh to rebuild - restoring is skipped until then."
    echo "Vesktop updated Vencord to rev $deployed_rev (build is $dist_rev). Re-run setup.sh to rebuild."
    exit 0
fi

# shellcheck disable=SC2086
for f in $FILES; do
    cp -f "$DIST/$f" "$TARGET/$f"
done
printf '%s' '{}' >"$TARGET/package.json"

count=$(echo "$mismatch" | wc -w)
log_msg "restored $count file(s) that had been replaced:$mismatch"
echo "Restored MacroDeckBridge Vencord build in $TARGET ($count file(s) fixed)."
