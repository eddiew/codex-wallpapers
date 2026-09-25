#!/bin/bash
# Removes Codex Wallpapers.app, its profile, and the installer's downloads.
# Your ChatGPT app and its data are untouched.
#
#   bash uninstall.sh [--keep-data]

set -euo pipefail

readonly APP="${HOME}/Applications/Codex Wallpapers.app"
readonly PROFILE="${HOME}/Library/Application Support/Codex Wallpapers"

osascript -e 'quit app id "com.codexwallpapers.desktop"' >/dev/null 2>&1 || true
sleep 1
pkill -f "${APP}/Contents/" 2>/dev/null || true

rm -rf "${APP}" "${HOME}/.codex-wallpapers"
echo "Removed ${APP}"
if [ "${1:-}" != "--keep-data" ]; then
    rm -rf "${PROFILE}"
    echo "Removed ${PROFILE}"
fi
echo "If you added wallpapers to another app with --onto, reinstall that app to remove them."
