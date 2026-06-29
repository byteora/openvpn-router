#!/usr/bin/env bash
#
# Download a self-contained `sing-box` binary into resources/bin/darwin so the
# packaged .app can run the fake-IP routing engine without anything installed.
#
# sing-box is a single static Go binary (no dylib deps), so unlike openvpn we
# only need to fetch + ad-hoc sign it. Bundles the current machine's arch by
# default; override with SINGBOX_ARCH=amd64|arm64.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/resources/bin/darwin"

ARCH="${SINGBOX_ARCH:-$(uname -m)}"
case "$ARCH" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=amd64 ;;
  *) echo "error: unsupported arch '$ARCH'" >&2; exit 1 ;;
esac

# Pin a known-good version (schema verified for the generated config). Override
# with SINGBOX_VERSION=1.x.y to bump.
VERSION="${SINGBOX_VERSION:-1.13.14}"
NAME="sing-box-${VERSION}-darwin-${ARCH}"
URL="https://github.com/SagerNet/sing-box/releases/download/v${VERSION}/${NAME}.tar.gz"

echo "Downloading $URL"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$URL" -o "$TMP/singbox.tar.gz"
tar -xzf "$TMP/singbox.tar.gz" -C "$TMP"

mkdir -p "$DEST"
cp "$TMP/$NAME/sing-box" "$DEST/sing-box"
chmod +x "$DEST/sing-box"

# Editing/copying invalidates any signature; on Apple Silicon an unsigned binary
# is killed on launch. Ad-hoc sign it.
codesign --force --sign - "$DEST/sing-box"

echo "--- version check ---"
"$DEST/sing-box" version | head -3 || true
echo "OK: bundled sing-box ${VERSION} (${ARCH}) into $DEST"
