#!/bin/sh
# Crewplane installer — downloads a signature- and checksum-verified release binary.
#
#   curl -fsSL https://raw.githubusercontent.com/yorch/crewplane/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/yorch/crewplane/main/install.sh |
#     sh -s -- --version v0.3.0 --dir "$HOME/bin"
#
# Flags:
#   --version TAG   install an exact release, e.g. v0.3.0 (default: latest)
#   --dir DIR       install directory (default: $CREWPLANE_INSTALL_DIR or ~/.local/bin)
#   --dry-run       resolve the release and print the plan without downloading
#   --allow-unverified
#                   only matters when this machine's openssl cannot verify
#                   Ed25519: proceed on the SHA-256 alone (loud warning). If
#                   openssl can verify, the signature is always required.
#   -h, --help      show this help
#
# Environment:
#   CREWPLANE_VERSION      same as --version
#   CREWPLANE_INSTALL_DIR  same as --dir
#   CREWPLANE_RELEASE_API  latest-release JSON (default: GitHub API)
#   CREWPLANE_RELEASE_BASE release download base URL (default: GitHub releases)
#
# Integrity: every release publishes <asset>.sha256 and, once signing is
# enabled, <asset>.sig: one or more lines, each base64 Ed25519 (optionally
# "<key id>:" first) over "crewplane-release-v1", tag, asset name and SHA-256,
# one per line. Any line verifying against any listed key is accepted, so a
# release can be signed by an old and a new key at once (rotation). Signing is
# enabled by listing a public key in the block below, which must equal
# release-keys.json (tests and CI check it; refresh with
# `bun scripts/sync-install-keys.ts`).
#   - keys configured: releases at or after the block's signedSince tag (all
#     releases when it is empty) require a valid signature. That needs an
#     openssl that verifies Ed25519 (`pkeyutl -verify -rawin`; OpenSSL 3.x, not
#     macOS's LibreSSL: `brew install openssl`, then put
#     "$(brew --prefix openssl@3)/bin" first on PATH, since it is keg-only).
#     A built-in known-answer test proves the local openssl works. If it does
#     not, the installer refuses unless --allow-unverified is given. A missing
#     or bad signature is never downgraded to SHA-256 only. Releases older
#     than signedSince install on SHA-256 alone, with a warning.
#   - no keys configured: SHA-256 only (same-origin, so it detects corruption
#     but not a replaced release).
# The known-answer test trusts the openssl on PATH; control of PATH already
# means code execution, so a hostile openssl is out of scope.
#
# Never run under sudo: install into a user-writable directory instead.
set -eu
umask 022

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
  say "  --allow-unverified  only if this machine's openssl cannot verify Ed25519:"
  say "                  install on the SHA-256 alone (never skips the checksum)"
  say "  -h, --help      show this help"
  say ""
  say "Environment: CREWPLANE_VERSION, CREWPLANE_INSTALL_DIR,"
  say "CREWPLANE_RELEASE_API, CREWPLANE_RELEASE_BASE."
  say "The binary is verified against its published SHA-256 and, when release"
  say "signing keys are configured, its Ed25519 signature (needs an openssl with"
  say "Ed25519 support) before it replaces an existing installation."
  say "Windows is unsupported."
}

# BEGIN RELEASE KEYS (generated from release-keys.json; do not edit)
release_signed_since=''
release_keys='
'
# END RELEASE KEYS

# RFC 8032 section 7.1 test 2 (message "r"): proves the local openssl really
# verifies Ed25519 and rejects altered input before it is trusted.
kat_public="PUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw="
kat_signature="kqAJqfDUyrhyDoILX2QlQKKye1QWUD+Ps3YiI+vbadoIWsHkPhWZbkWPNhPQ8R2MOHsurrQwKu6wDSkWErsMAA=="
# base64 of the 12-byte SPKI header that wraps a raw 32-byte Ed25519 key.
spki_prefix_b64="MCowBQYDK2VwAyEA"

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

# Exact loopback host, optional :DIGITS port, then / or end; no userinfo ('@').
loopback_http_ok() { # url
  rest=${1#http://}
  case "$rest" in *@*) return 1 ;; esac
  authority=${rest%%[/?#]*}
  case "$authority" in
    127.0.0.1 | localhost | "[::1]") return 0 ;;
    127.0.0.1:* | localhost:* | "[::1]":*)
      port=${authority##*:}
      case "$port" in '' | *[!0-9]*) return 1 ;; esac
      return 0
      ;;
  esac
  return 1
}

require_secure_url() { # url
  case "$1" in
    https://*) ;;
    http://*) loopback_http_ok "$1" || die "refusing non-https URL (plain http is allowed only for loopback): $1" ;;
    *) die "refusing non-https URL (plain http is allowed only for loopback): $1" ;;
  esac
}

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
      curl -fL --progress-bar --max-redirs 0 --connect-timeout 10 --max-time 600 \
        "$url" -o "$dest"
    fi
  elif [ "$https_only" -eq 1 ]; then
    curl -fsSL --proto '=https' --proto-redir '=https' \
      --connect-timeout 10 --max-time 600 "$url" -o "$dest"
  else
    curl -fsSL --max-redirs 0 --connect-timeout 10 --max-time 600 "$url" -o "$dest"
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

keys_configured() {
  [ -n "$(printf '%s' "$release_keys" | tr -d ' \t\r\n')" ]
}

# write_public_pem BASE64 DEST: raw 32-byte (44 chars) or SPKI DER (60 chars).
write_public_pem() {
  pem_body=$1
  case ${#pem_body} in
    44) pem_body="$spki_prefix_b64$pem_body" ;;
    60) ;;
    *) return 1 ;;
  esac
  printf -- '-----BEGIN PUBLIC KEY-----\n%s\n-----END PUBLIC KEY-----\n' \
    "$pem_body" >"$2"
}

ed25519_verify() { # pem message-file signature-file
  openssl pkeyutl -verify -pubin -inkey "$1" -rawin -in "$2" -sigfile "$3" \
    >/dev/null 2>&1
}

# Known-answer probe: a good vector must verify and an altered message must not.
openssl_verifies_ed25519() {
  command -v openssl >/dev/null 2>&1 || return 1
  write_public_pem "$kat_public" "$tmp/kat.pem" || return 1
  printf '%s' "$kat_signature" | openssl base64 -d -A >"$tmp/kat.sig" 2>/dev/null ||
    return 1
  printf 'r' >"$tmp/kat.msg"
  printf 's' >"$tmp/kat.bad"
  ed25519_verify "$tmp/kat.pem" "$tmp/kat.msg" "$tmp/kat.sig" || return 1
  if ed25519_verify "$tmp/kat.pem" "$tmp/kat.bad" "$tmp/kat.sig"; then return 1; fi
  return 0
}

# version_ge A B: success when release tag A >= B, numeric semver. Prerelease
# identifiers compare as plain strings here, a simplification of semver that
# only matters for a signedSince that is itself a prerelease.
version_ge() {
  awk -v a="$1" -v b="$2" '
    function parse(v, out,   plus, dash, core, n, parts) {
      sub(/^v/, "", v)
      plus = index(v, "+")
      if (plus) v = substr(v, 1, plus - 1)
      dash = index(v, "-")
      out["pre"] = ""
      core = v
      if (dash) { core = substr(v, 1, dash - 1); out["pre"] = substr(v, dash + 1) }
      n = split(core, parts, ".")
      out[1] = parts[1] + 0; out[2] = parts[2] + 0; out[3] = parts[3] + 0
    }
    BEGIN {
      parse(a, x); parse(b, y)
      for (i = 1; i <= 3; i++) if (x[i] != y[i]) exit (x[i] > y[i]) ? 0 : 1
      if (x["pre"] == y["pre"] || x["pre"] == "") exit 0
      if (y["pre"] == "") exit 1
      exit (x["pre"] >= y["pre"]) ? 0 : 1
    }'
}

# A signature is canonical base64 of exactly 64 bytes: 86 characters whose last
# one carries four zero bits (A, Q, g or w), then "==".
canonical_signature() {
  case "$1" in *==) ;; *) return 1 ;; esac
  sig_body=${1%==}
  [ "${#sig_body}" -eq 86 ] || return 1
  case "$sig_body" in *[!A-Za-z0-9+/]*) return 1 ;; esac
  case "$sig_body" in *[AQgw]) return 0 ;; esac
  return 1
}

# verify_signature SIGFILE: any line (at most 8) verifying against any
# configured key, or only the one named by the line's optional "<id>:" prefix,
# accepts the tag/asset/hash message. Unusable lines are skipped.
verify_signature() {
  printf 'crewplane-release-v1\n%s\n%s\n%s\n' "$version" "$asset" "$actual" \
    >"$tmp/release.msg"
  printf '%s\n' "$release_keys" >"$tmp/release.keys"
  signed_by=""
  sig_lines=0
  while IFS= read -r sig_raw || [ -n "$sig_raw" ]; do
    sig_line=$(printf '%s' "$sig_raw" | tr -d ' \t\r')
    [ -n "$sig_line" ] || continue
    sig_lines=$((sig_lines + 1))
    [ "$sig_lines" -le 8 ] || return 1
    want_id=""
    sigb64=$sig_line
    case "$sig_line" in
      *:*)
        want_id=${sig_line%%:*}
        sigb64=${sig_line#*:}
        ;;
    esac
    canonical_signature "$sigb64" || continue
    printf '%s' "$sigb64" | openssl base64 -d -A >"$tmp/release.sig" 2>/dev/null ||
      continue
    [ "$(wc -c <"$tmp/release.sig" | tr -d ' ')" -eq 64 ] || continue
    while read -r key_id key_b64; do
      [ -n "$key_id" ] || continue
      if [ -n "$want_id" ] && [ "$key_id" != "$want_id" ]; then continue; fi
      write_public_pem "$key_b64" "$tmp/release.pem" || continue
      if ed25519_verify "$tmp/release.pem" "$tmp/release.msg" "$tmp/release.sig"; then
        signed_by=$key_id
        return 0
      fi
    done <"$tmp/release.keys"
  done <"$1"
  return 1
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
  require_secure_url "$api"
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
allow_unverified=0

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
    --allow-unverified)
      allow_unverified=1
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
require_secure_url "$base"
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

verify_mode=sha256
if keys_configured; then
  if [ -n "$release_signed_since" ] && ! version_ge "$version" "$release_signed_since"; then
    warn "WARNING: $version predates signed releases (signing starts at $release_signed_since)."
    warn "WARNING: installing on the SHA-256 from the same release only."
  elif openssl_verifies_ed25519; then
    # A capable openssl always verifies, whatever --allow-unverified says.
    verify_mode=signed
  elif [ "$allow_unverified" -eq 1 ]; then
    verify_mode=unverified
    warn "WARNING: this machine's openssl cannot verify Ed25519 and --allow-unverified"
    warn "WARNING: was given: release signatures will NOT be checked. Only the SHA-256"
    warn "WARNING: from the same release is verified, which cannot detect a replaced"
    warn "WARNING: release. Install OpenSSL 3 instead."
  else
    die "this release is signed, but this machine's openssl cannot verify Ed25519 signatures (macOS ships LibreSSL, which cannot). Install OpenSSL 3 (for example: brew install openssl) and put it first on PATH (Homebrew's is keg-only: export PATH=\"\$(brew --prefix openssl@3)/bin:\$PATH\"). Only if that is impossible, --allow-unverified installs on the SHA-256 alone (not recommended); it has no effect when openssl can verify."
  fi
else
  step "note: no release signing keys are configured; verifying SHA-256 only"
fi

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

if [ "$verify_mode" = signed ]; then
  step "verifying the release signature"
  fetch "$base/$version/$asset.sig" "$tmp/$asset.sig" ||
    die "no signature published for $asset in $version; refusing to install"
  verify_signature "$tmp/$asset.sig" ||
    die "signature verification failed for $asset; refusing to install"
  step "signature verified (key $signed_by)"
fi

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
