#!/bin/sh
# Installs Wisp, the latest release, for macOS or Linux.
#
#   curl -fsSL https://willowisp.dev/install.sh | sh
#
# It downloads the archive for this machine from GitHub Releases, checks it against the
# release's SHA256SUMS, and puts `wisp` in ~/.local/bin. Read it first if you like: it
# needs no sudo and touches nothing else.
#
#   WISP_VERSION=v0.1.0   a release other than the latest
#   WISP_INSTALL_DIR=...  somewhere other than ~/.local/bin

set -eu

REPO="phrp720/wisp"
VERSION="${WISP_VERSION:-latest}"
INSTALL_DIR="${WISP_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
fail() { printf 'wisp install: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) fail "this script is for macOS and Linux. On Windows, download wisp-windows-x64.zip from https://github.com/$REPO/releases" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) fail "no build for $(uname -m) yet" ;;
esac

if [ "$VERSION" = "latest" ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi
archive="wisp-$os-$arch.tar.gz"

command -v curl >/dev/null 2>&1 || fail "curl is needed"
command -v tar >/dev/null 2>&1 || fail "tar is needed"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM

say "Downloading $archive ($VERSION)…"
curl -fsSL "$base/$archive" -o "$work/$archive" || fail "could not download $base/$archive"
curl -fsSL "$base/SHA256SUMS" -o "$work/SHA256SUMS" || fail "could not download the checksums"

expected="$(grep " $archive\$" "$work/SHA256SUMS" | cut -d' ' -f1)"
[ -n "$expected" ] || fail "$archive is not in the release's checksums"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$work/$archive" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "$work/$archive" | cut -d' ' -f1)"
fi
[ "$expected" = "$actual" ] || fail "the download does not match its checksum; nothing was installed"

tar -xzf "$work/$archive" -C "$work"
mkdir -p "$INSTALL_DIR"
mv "$work/wisp" "$INSTALL_DIR/wisp"
chmod +x "$INSTALL_DIR/wisp"

say "Installed $("$INSTALL_DIR/wisp" --version 2>/dev/null || echo wisp) to $INSTALL_DIR/wisp"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) say "Run \`wisp\` in a project to start." ;;
  *) say "Add $INSTALL_DIR to your PATH, then run \`wisp\` in a project to start." ;;
esac
