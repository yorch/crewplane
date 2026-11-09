#!/bin/sh
# Crewplane installer — downloads a checksum-verified release binary.
#
#   curl -fsSL https://raw.githubusercontent.com/yorch/crewplane/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/yorch/crewplane/main/install.sh |
#     sh -s -- --version v0.3.0 --dir "$HOME/bin"
#
# Flags:
#   --version TAG   install an exact release, e.g. v0.3.0 (default: latest)
#   --dir DIR       install directory (default: $CREWPLANE_INSTALL_DIR or ~/.local/bin)
#   --dry-run       resolve the release and print the plan without downloading
#   -h, --help      show this help
#
# Environment:
#   CREWPLANE_VERSION      same as --version
#   CREWPLANE_INSTALL_DIR  same as --dir
#   CREWPLANE_RELEASE_API  latest-release JSON (default: GitHub API)
#   CREWPLANE_RELEASE_BASE release download base URL (default: GitHub releases)
#
# Never run under sudo: install into a user-writable directory instead.
set -eu

repo="yorch/crewplane"

say() { printf '%s\n' "$*"; }
warn() { printf 'install: %s\n' "$*" >&2; }
step() { printf 'install: %s\n' "$*" >&2; }
die() {
  warn "$*"
  exit 1
}

format_bytes() {
  awk -v bytes="$1" 'BEGIN {
    if (bytes >= 1048576) printf "%.1f MB", bytes / 1048576
    else if (bytes >= 1024) printf "%.1f KB", bytes / 1024
    else printf "%d B", bytes
  }'
}

# Progress belongs on stderr so stdout stays a stable result line.
tty_progress=0
if [ -t 2 ]; then tty_progress=1; fi

usage() {
  say "Install the Crewplane CLI from a GitHub release."
  say ""
  say "Usage: install.sh [--version TAG] [--dir DIR] [--dry-run] [--help]"
  say ""
  say "  --version TAG   exact release to install (default: latest)"
  say "  --dir DIR       install directory (default: ~/.local/bin; alias --prefix)"
  say "  --dry-run       print the resolved plan without downloading"
  say "  -h, --help      show this help"
  say ""
  say "Environment: CREWPLANE_VERSION, CREWPLANE_INSTALL_DIR,"
  say "CREWPLANE_RELEASE_API, CREWPLANE_RELEASE_BASE."
  say "The binary is verified against its published SHA-256 before it replaces"
  say "an existing installation. Windows is unsupported."
}

tmp=""
stage=""
cleanup() {
  if [ -n "$stage" ]; then rm -f "$stage" || true; fi
  if [ -n "$tmp" ]; then rm -rf "$tmp" || true; fi
}
on_signal() {
  cleanup
  exit "$1"
}
trap cleanup EXIT
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

curl_fetch() {
  url=$1
  dest=$2
  mode=$3
  case "$url" in
    https://*) https_only=1 ;;
    *) https_only=0 ;;
  esac
  if [ "$mode" = progress ] && [ "$tty_progress" -eq 1 ]; then
    if [ "$https_only" -eq 1 ]; then
      curl -fL --progress-bar --proto '=https' --proto-redir '=https' \
        --connect-timeout 10 --max-time 600 "$url" -o "$dest"
    else
      curl -fL --progress-bar --connect-timeout 10 --max-time 600 \
        "$url" -o "$dest"
    fi
  elif [ "$https_only" -eq 1 ]; then
    curl -fsSL --proto '=https' --proto-redir '=https' \
      --connect-timeout 10 --max-time 600 "$url" -o "$dest"
  else
    curl -fsSL --connect-timeout 10 --max-time 600 "$url" -o "$dest"
  fi
}

fetch() { # url dest [progress|quiet]
  url=$1
  dest=$2
  mode=${3:-quiet}
  command -v curl >/dev/null 2>&1 ||
    die "curl is required to download release assets"
  attempt=1
  while [ "$attempt" -le 3 ]; do
    started=$(date +%s)
    if curl_fetch "$url" "$dest" "$mode"; then
      if [ "$mode" = progress ]; then
        if [ "$tty_progress" -eq 1 ]; then printf '\n' >&2; fi
        finished=$(date +%s)
        bytes=$(wc -c <"$dest" | tr -d ' ')
        step "downloaded $(format_bytes "$bytes") in $((finished - started))s"
      fi
      return 0
    fi
    if [ "$attempt" -lt 3 ]; then
      warn "download failed (attempt $attempt/3), retrying: $url"
    else
      warn "download failed (attempt 3/3): $url"
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -le 3 ]; then sleep 1; fi
  done
  return 1
}

have_hash() {
  command -v sha256sum >/dev/null 2>&1 ||
    command -v shasum >/dev/null 2>&1 ||
    command -v openssl >/dev/null 2>&1
}

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    openssl dgst -sha256 "$1" | awk '{ print $NF }'
  fi
}

normalize_version() {
  candidate=$1
  case "$candidate" in
    "" | *[!A-Za-z0-9._+-]*)
      die "invalid version '$1' (expected MAJOR.MINOR.PATCH)"
      ;;
  esac
  case "$candidate" in
    v*) ;;
    *) candidate="v$candidate" ;;
  esac
  printf '%s\n' "$candidate" |
    grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?(\+[0-9A-Za-z.-]+)?$' ||
    die "invalid version '$1' (expected MAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH)"
  printf '%s\n' "$candidate"
}

resolve_latest() {
  api="${CREWPLANE_RELEASE_API:-https://api.github.com/repos/$repo/releases/latest}"
  step "resolving the latest release"
  fetch "$api" "$tmp/latest.json" || die "could not reach $api"
  tag=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$tmp/latest.json" | head -n 1)
  [ -n "$tag" ] || die "could not resolve the latest release from $api"
  normalize_version "$tag"
}

version="${CREWPLANE_VERSION:-latest}"
dir="${CREWPLANE_INSTALL_DIR:-}"
dry_run=0
pinned=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die "--version requires a value"
      version=$2
      pinned=1
      shift 2
      ;;
    --version=*)
      version=${1#--version=}
      pinned=1
      shift
      ;;
    --dir | --prefix)
      [ "$#" -ge 2 ] || die "$1 requires a value"
      dir=$2
      shift 2
      ;;
    --dir=*)
      dir=${1#--dir=}
      shift
      ;;
    --prefix=*)
      dir=${1#--prefix=}
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*) die "unknown option $1 (try --help)" ;;
    *)
      version=$1
      pinned=1
      shift
      ;;
  esac
done

if [ -z "$version" ]; then die "version must not be empty"; fi
if [ "$version" = latest ]; then pinned=0; else pinned=1; fi

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) die "unsupported OS $(uname -s) (published: Linux and macOS)" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64 | x64) arch=x86_64 ;;
  arm64 | arm64e | aarch64 | armv8*) arch=arm64 ;;
  *) die "unsupported architecture $(uname -m) (published: x86_64 and arm64)" ;;
esac

if [ -z "$dir" ]; then
  [ -n "${HOME:-}" ] || die "HOME is unset; pass --dir DIR"
  dir="$HOME/.local/bin"
fi
case "$dir" in
  [~]) dir=${HOME:?HOME is unset} ;;
  [~]/*) dir="${HOME:?HOME is unset}/${dir#?/}" ;;
  /*) ;;
  *) dir="$PWD/$dir" ;;
esac

if [ "$version" = latest ]; then
  tmp=$(mktemp -d 2>/dev/null) || die "cannot create a temporary directory"
  version=$(resolve_latest)
else
  version=$(normalize_version "$version")
fi

asset="crewplane-$version-$os-$arch"
base="${CREWPLANE_RELEASE_BASE:-https://github.com/$repo/releases/download}"
base=${base%/}
target="$dir/crewplane"

if [ "$dry_run" -eq 1 ]; then
  say "Would install crewplane $version ($os-$arch)"
  say "  asset:  $asset"
  say "  source: $base/$version/$asset"
  say "  target: $target"
  exit 0
fi

have_hash ||
  die "sha256sum, shasum or openssl is required to verify the download"
mkdir -p "$dir" || die "cannot create install directory $dir"
[ -d "$dir" ] || die "$dir is not a directory"
[ -w "$dir" ] || die "$dir is not writable; use --dir or fix permissions (avoid sudo)"
[ -n "$tmp" ] || tmp=$(mktemp -d 2>/dev/null) || die "cannot create a temporary directory"

previous=""
if [ -e "$target" ] || [ -L "$target" ]; then
  [ -f "$target" ] || die "$target exists and is not a regular file"
  [ -w "$target" ] || die "$target is not writable; install elsewhere with --dir"
  if [ -L "$target" ]; then
    warn "$target is a symbolic link and will be replaced by a real file"
  fi
  previous=$("$target" --version </dev/null 2>/dev/null || true)
fi

stage=$(mktemp "$dir/.crewplane.XXXXXX" 2>/dev/null) ||
  die "cannot create a staging file in $dir"
step "downloading crewplane $version ($os-$arch)"
fetch "$base/$version/$asset" "$stage" progress ||
  die "no published binary for $os-$arch in $version"
fetch "$base/$version/$asset.sha256" "$tmp/$asset.sha256" ||
  die "no checksum published for $asset in $version"

step "verifying the checksum"
expected=$(awk -v name="$asset" '
  {
    hash = $1
    file = $2
    sub(/^\*/, "", file)
    sub(/\r$/, "", file)
    if (file == "" || file == name) { print hash; exit }
  }
' "$tmp/$asset.sha256")
case "$expected" in
  "" | *[!0-9a-fA-F]*) die "unreadable checksum for $asset; refusing to install" ;;
esac
[ "${#expected}" -eq 64 ] ||
  die "unreadable checksum for $asset; refusing to install"
expected=$(printf '%s\n' "$expected" | tr 'A-F' 'a-f')
actual=$(hash_file "$stage")
[ "$actual" = "$expected" ] ||
  die "checksum mismatch for $asset; refusing to install"

chmod +x "$stage"
step "checking the downloaded binary"
downloaded=$("$stage" --version </dev/null 2>/dev/null || true)
[ -n "$downloaded" ] ||
  die "downloaded $asset does not run on this machine ($os-$arch)"
[ "$downloaded" = "${version#v}" ] ||
  die "downloaded $asset reports $downloaded but $version was requested"

step "installing to $target"
mv -f "$stage" "$target"
stage=""
installed=$("$target" --version </dev/null 2>/dev/null || true)
[ -n "$installed" ] || installed=${version#v}

if [ -n "$previous" ] && [ "$previous" != "$installed" ]; then
  say "Updated crewplane $previous -> $installed at $target"
elif [ -n "$previous" ]; then
  say "Reinstalled crewplane $installed at $target"
else
  say "Installed crewplane $installed at $target"
fi
if [ "$pinned" -eq 1 ]; then
  say "Pinned $version is not sticky: release builds resume automatic updates."
  say "Set CREWPLANE_NO_AUTO_UPDATE=1 to stay on this version."
fi

case ":${PATH:-}:" in
  *":$dir:"*) ;;
  *) say "Add $dir to PATH: export PATH=\"$dir:\$PATH\"" ;;
esac
resolved=$(command -v crewplane 2>/dev/null || true)
if [ -n "$resolved" ] && [ "$resolved" != "$target" ]; then
  warn "note: '$resolved' currently comes first on PATH"
fi
