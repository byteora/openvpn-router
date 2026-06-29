#!/usr/bin/env bash
#
# Bundle a self-contained `openvpn` binary (plus its non-system dylibs) into
# resources/bin/darwin so the packaged .app works without Homebrew installed.
#
# Run on a build machine that already has `openvpn` (e.g. `brew install openvpn`)
# and `dylibbundler` (`brew install dylibbundler`). The result is copied into the
# .app by electron-builder via the `extraResources` mapping in package.json.
#
# Note: this bundles the *current* machine's architecture only. Run it on Apple
# Silicon to ship arm64, on Intel for x86_64 (or lipo two builds for universal).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/resources/bin/darwin"

# --- locate a source openvpn ------------------------------------------------
SRC="$(command -v openvpn || true)"
if [ -z "$SRC" ]; then
  for p in /opt/homebrew/sbin/openvpn /usr/local/sbin/openvpn \
           /opt/homebrew/bin/openvpn /usr/local/bin/openvpn; do
    if [ -x "$p" ]; then SRC="$p"; break; fi
  done
fi
if [ -z "$SRC" ]; then
  echo "error: no 'openvpn' binary found. Install one first: brew install openvpn" >&2
  exit 1
fi
if ! command -v dylibbundler >/dev/null 2>&1; then
  echo "error: dylibbundler not found. Install it: brew install dylibbundler" >&2
  exit 1
fi

echo "Source openvpn: $SRC"
echo "Architecture:   $(file -b "$SRC")"

# --- copy + collect deps ----------------------------------------------------
rm -rf "$DEST"
mkdir -p "$DEST/libs"
cp "$SRC" "$DEST/openvpn"
chmod u+w "$DEST/openvpn"

# Gather every non-system dylib into libs/ and rewrite install names to point at
# @executable_path/libs (resolved relative to the openvpn binary at runtime).
dylibbundler \
  --overwrite-dir \
  --bundle-deps \
  --fix-file "$DEST/openvpn" \
  --dest-dir "$DEST/libs" \
  --install-path "@executable_path/libs/"

# --- re-sign ----------------------------------------------------------------
# Editing a Mach-O invalidates its signature; on Apple Silicon an unsigned/
# invalid binary is killed on launch. Ad-hoc sign everything we touched.
find "$DEST/libs" -name '*.dylib' -exec codesign --force --sign - {} +
codesign --force --sign - "$DEST/openvpn"

# --- verify -----------------------------------------------------------------
echo "--- remaining external (non-system) references ---"
if otool -L "$DEST/openvpn" | grep -E '/opt/homebrew|/usr/local'; then
  echo "error: binary still references Homebrew paths — bundling failed" >&2
  exit 1
fi
echo "(none)"

echo "--- version check ---"
"$DEST/openvpn" --version | head -1 || true

echo "OK: bundled into $DEST"
