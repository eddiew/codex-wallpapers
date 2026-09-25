#!/bin/bash
# Codex Wallpapers installer.
#
#   curl -fsSL https://raw.githubusercontent.com/OWNER/codex-wallpapers/main/install.sh | bash
#
# Builds "Codex Wallpapers.app" in ~/Applications from your installed ChatGPT
# desktop app. Your ChatGPT app is never modified. Arguments are passed to the
# patcher, for example:
#
#   curl -fsSL …/install.sh | bash -s -- --onto "$HOME/Applications/Codex Subscription Router.app"

set -euo pipefail

readonly REPOSITORY="${CODEX_WALLPAPERS_REPOSITORY:-OWNER/codex-wallpapers}"
readonly BRANCH="${CODEX_WALLPAPERS_BRANCH:-main}"
readonly HOME_DIR="${HOME}/.codex-wallpapers"
readonly NODE_VERSION="24.21.0"

log() { printf '\033[1m==>\033[0m %s\n' "$1" >&2; }
fail() {
    printf '\n\033[31mCodex Wallpapers:\033[0m %s\n' "$1" >&2
    exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "Codex Wallpapers supports macOS only."
if [ ! -d "/Applications/ChatGPT.app" ] && [[ " $* " != *" --onto "* ]] && [[ " $* " != *" --source "* ]]; then
    fail "install the ChatGPT desktop app in /Applications first."
fi

# Node.js: use the one on PATH when it's recent enough, otherwise fetch an
# official build into ~/.codex-wallpapers (checksum verified).
node_ok() {
    command -v "$1" >/dev/null 2>&1 && [ "$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ]
}

resolve_node() {
    if node_ok node; then
        command -v node
        return
    fi
    local arch
    case "$(uname -m)" in
        arm64) arch="arm64" ;;
        x86_64) arch="x64" ;;
        *) fail "unsupported architecture $(uname -m)." ;;
    esac
    local name="node-v${NODE_VERSION}-darwin-${arch}"
    local dir="${HOME_DIR}/runtime/${name}"
    if node_ok "${dir}/bin/node"; then
        printf '%s\n' "${dir}/bin/node"
        return
    fi
    log "Downloading Node.js ${NODE_VERSION} (used only to run the patcher)"
    local base="https://nodejs.org/dist/v${NODE_VERSION}"
    local tmp
    tmp="$(mktemp -d)"
    curl -fsSL "${base}/${name}.tar.gz" -o "${tmp}/${name}.tar.gz"
    curl -fsSL "${base}/SHASUMS256.txt" -o "${tmp}/SHASUMS256.txt"
    (cd "${tmp}" && grep " ${name}.tar.gz\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null) ||
        fail "the Node.js download failed its checksum."
    mkdir -p "${HOME_DIR}/runtime"
    tar -xzf "${tmp}/${name}.tar.gz" -C "${HOME_DIR}/runtime"
    rm -rf "${tmp}"
    printf '%s\n' "${dir}/bin/node"
}

# Source: the checkout this script sits in, or the latest from GitHub.
resolve_source() {
    local script="${BASH_SOURCE[0]:-}"
    if [ -n "${script}" ] && [ -f "${script}" ]; then
        local dir
        dir="$(cd -- "$(dirname -- "${script}")" && pwd)"
        if [ -f "${dir}/bin/patch.mjs" ]; then
            printf '%s\n' "${dir}"
            return
        fi
    fi
    log "Downloading Codex Wallpapers"
    local source="${HOME_DIR}/source"
    local tmp
    tmp="$(mktemp -d)"
    curl -fsSL "https://codeload.github.com/${REPOSITORY}/tar.gz/refs/heads/${BRANCH}" | tar -xz -C "${tmp}"
    rm -rf "${source}"
    mkdir -p "${HOME_DIR}"
    mv "${tmp}"/*/ "${source}"
    rm -rf "${tmp}"
    printf '%s\n' "${source}"
}

NODE="$(resolve_node)"
SOURCE="$(resolve_source)"
exec "${NODE}" "${SOURCE}/bin/patch.mjs" "$@"
