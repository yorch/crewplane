#!/bin/sh
# Install the Crewplane CLI from a GitHub release.
#   curl -fsSL https://raw.githubusercontent.com/yorch/crewplane/main/install.sh | sh
# Environment:
#   CREWPLANE_VERSION      version to install, e.g. v0.2.0 (default: latest)
#   CREWPLANE_INSTALL_DIR  target directory (default: $HOME/.local/bin)
set -eu

repo="yorch/crewplane"
dir="${CREWPLANE_INSTALL_DIR:-$HOME/.local/bin}"
version="${CREWPLANE_VERSION:-latest}"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) echo "install: unsupported OS $(uname -s) (Linux and macOS only)" >&2; exit 1 ;;
esac
arch="$(uname -m)"

if [ "$version" = latest ]; then
  version="$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" |
    sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$version" ] || { echo "install: could not resolve latest release" >&2; exit 1; }
fi

asset="crewplane-$version-$os-$arch"
base="https://github.com/$repo/releases/download/$version"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Installing crewplane $version ($os-$arch) to $dir"
if ! curl -fsSL "$base/$asset" -o "$tmp/$asset" ||
   ! curl -fsSL "$base/$asset.sha256" -o "$tmp/$asset.sha256"; then
  echo "install: no published binary for $os-$arch in $version" >&2
  exit 1
fi

cd "$tmp"
if command -v sha256sum >/dev/null 2>&1; then sha256sum -c "$asset.sha256" >/dev/null
elif command -v shasum >/dev/null 2>&1; then shasum -a 256 -c "$asset.sha256" >/dev/null
else echo "install: sha256sum or shasum required for verification" >&2; exit 1
fi

mkdir -p "$dir"
chmod +x "$asset"
mv "$asset" "$dir/crewplane"
echo "Installed: $dir/crewplane"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "Add to PATH: export PATH=\"$dir:\$PATH\"" ;;
esac
